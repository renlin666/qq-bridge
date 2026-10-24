import {
  createSocialMemory,
  createWhitelistPolicy,
  createManualClock,
  MockIndexAdapter
} from '../src/index.js';

export function makeHarness({ config = {}, adapter = new MockIndexAdapter(), policy, relationshipPolicy } = {}) {
  // 用中午而不是零点，避免测试机时区不同导致“本地日界”把当天事件算到前一天。
  const clock = createManualClock('2026-01-01T12:00:00.000Z');
  const effectivePolicy = policy ?? createWhitelistPolicy({
    bots: {
      'bot-a': {
        groups: ['group-1', 'group-2'],
        people: ['u-a', 'u-b', 'u-c']
      },
      'bot-b': {
        groups: ['group-1'],
        people: ['u-a']
      }
    }
  });
  const service = createSocialMemory({ clock, policy: effectivePolicy, adapter, config, relationshipPolicy });
  return { clock, policy: effectivePolicy, adapter, service };
}

export function privateContext(userId, displayName = userId, botAccountId = 'bot-a') {
  return {
    platform: 'qq',
    botAccountId,
    conversation: { kind: 'private', id: `dm:${userId}` },
    actor: { userId, displayName },
    sessionId: `session:${botAccountId}:${userId}`
  };
}

export function groupContext(userId, displayName = userId, {
  botAccountId = 'bot-a',
  groupId = 'group-1'
} = {}) {
  return {
    platform: 'qq',
    botAccountId,
    conversation: { kind: 'group', id: `group:${groupId}`, groupId },
    actor: { userId, displayName },
    sessionId: `session:${botAccountId}:group:${groupId}`
  };
}
