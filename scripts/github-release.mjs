// CI-only release publication. Uses the runner's short-lived, repository-scoped token.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function publishRelease({ env, version, notes, fetcher = fetch }) {
  const tag = 'v' + version;
  if (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_TOKEN) throw new Error('GitHub release publication is CI-only');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    || env.GITHUB_REF_NAME !== 'release/' + tag || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY)) throw new Error('Release branch, package version or commit does not match');
  const origin = 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY;
  async function api(route, body, allowMissing = false) {
    const response = await fetcher(origin + route, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_TOKEN,
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'qq-bridge-release' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error('GitHub release API failed: HTTP ' + response.status);
    return response.json();
  }
  const existingTag = await api('/git/ref/tags/' + tag, null, true);
  if (existingTag && existingTag.object?.sha !== env.GITHUB_SHA) throw new Error('Published tag points at a different commit; refusing to overwrite');
  if (!existingTag) await api('/git/refs', { ref: 'refs/tags/' + tag, sha: env.GITHUB_SHA });
  const existingRelease = await api('/releases/tags/' + tag, null, true);
  if (existingRelease) return { url: existingRelease.html_url, existing: true };
  const release = await api('/releases', { tag_name: tag, target_commitish: env.GITHUB_SHA,
    name: tag + ' · Project plugin API v1', body: notes, draft: false, prerelease: version.includes('-') });
  return { url: release.html_url, existing: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const section = changelog.split('\n## ').find(value => value.startsWith(pkg.version + ' '));
  if (!section) throw new Error('Release version is missing from CHANGELOG.md');
  const result = await publishRelease({ env: process.env, version: pkg.version, notes: '## ' + section.trim() });
  console.log('Release published:', result.url);
}
