import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishRelease } from './github-release.mjs';

const env = { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'fixture-token', GITHUB_REPOSITORY: 'fixture/bridge',
  GITHUB_REF_NAME: 'release/v0.3.0-rc.1', GITHUB_SHA: 'a'.repeat(40) };
const options = { env, version: '0.3.0-rc.1', notes: 'fixture release' };
const response = (status, value = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => value });

test('release publication rejects local runs and mismatched branch/version/commit before network access', async () => {
  for (const invalid of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF_NAME: 'main' }, { GITHUB_SHA: 'bad' }, { GITHUB_REPOSITORY: 'fixture/bridge/../../other' }]) {
    await assert.rejects(publishRelease({ ...options, env: { ...env, ...invalid }, fetcher: () => assert.fail('must not access network') }));
  }
});
test('a validated candidate publishes the exact commit as a prerelease without following redirects', async () => {
  const requests = [];
  const result = await publishRelease({ ...options, fetcher: async (url, init) => {
    requests.push({ url, init });
    if (init.method === 'GET') return response(404);
    return response(201, { html_url: 'https://github.com/fixture/bridge/releases/tag/v0.3.0-rc.1' });
  } });
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.url.startsWith('https://api.github.com/repos/fixture/bridge/') && request.init.redirect === 'error'));
  const tag = JSON.parse(requests[1].init.body); assert.deepEqual(tag, { ref: 'refs/tags/v0.3.0-rc.1', sha: env.GITHUB_SHA });
  const release = JSON.parse(requests[3].init.body); assert.equal(release.target_commitish, env.GITHUB_SHA); assert.equal(release.prerelease, true);
  assert.equal(result.existing, false);
});
test('an existing different tag is never overwritten and no release is created', async () => {
  let calls = 0;
  await assert.rejects(publishRelease({ ...options, fetcher: async () => { calls++; return response(200, { object: { sha: 'b'.repeat(40) } }); } }), /refusing to overwrite/);
  assert.equal(calls, 1);
});
test('rerunning a published release is idempotent', async () => {
  const methods = [];
  const result = await publishRelease({ ...options, fetcher: async (url, init) => {
    methods.push(init.method);
    return response(200, url.includes('/git/ref/') ? { object: { sha: env.GITHUB_SHA } } : { html_url: 'fixture-release-url' });
  } });
  assert.deepEqual(methods, ['GET', 'GET']); assert.equal(result.existing, true);
});
test('release API errors do not echo the runner token or response body', async () => {
  await assert.rejects(publishRelease({ ...options, fetcher: async () => response(403, { message: env.GITHUB_TOKEN }) }), error => {
    assert.match(error.message, /HTTP 403/); assert.ok(!error.message.includes(env.GITHUB_TOKEN)); return true;
  });
});
