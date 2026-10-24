import { ERROR_CODES, fail } from './errors.js';

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeEntry(entry) {
  if (!entry || entry.enabled === false) return { groups: new Set(), people: new Set() };
  return {
    groups: new Set(asArray(entry.groups ?? entry.groupWhitelist ?? entry.groupIds).map(String)),
    people: new Set(asArray(entry.people ?? entry.allowedPeople ?? entry.personIds).map(String))
  };
}

function normalizeBots(bots) {
  const output = new Map();
  if (Array.isArray(bots)) {
    for (const entry of bots) {
      if (!entry || !entry.botAccountId) continue;
      output.set(String(entry.botAccountId), normalizeEntry(entry));
    }
    return output;
  }
  for (const [botAccountId, entry] of Object.entries(bots ?? {})) {
    output.set(String(botAccountId), normalizeEntry(entry));
  }
  return output;
}

/**
 * 群聊白名单与允许建档人物名单分开。这个对象是宿主侧配置的策略源，
 * 不做持久化；它可以在进程内被管理员显式更新，下一次调用立即生效。
 */
export function createWhitelistPolicy({ platform = 'qq', bots = {} } = {}) {
  let currentPlatform = String(platform);
  let state = normalizeBots(bots);

  const ensureBot = (botAccountId) => {
    const key = String(botAccountId ?? '');
    if (!state.has(key)) state.set(key, normalizeEntry(undefined));
    return state.get(key);
  };

  return {
    platform: currentPlatform,
    isBotConfigured(botAccountId) {
      return state.has(String(botAccountId ?? ''));
    },
    isGroupAllowed(botAccountId, groupId) {
      const entry = state.get(String(botAccountId ?? ''));
      return Boolean(entry?.groups.has(String(groupId ?? '')));
    },
    isPersonAllowed(botAccountId, userId) {
      const entry = state.get(String(botAccountId ?? ''));
      return Boolean(entry?.people.has(String(userId ?? '')));
    },
    /** 私聊沿用“允许建档人物名单”，不复用群白名单。 */
    isPrivateAllowed(botAccountId, userId) {
      return this.isPersonAllowed(botAccountId, userId);
    },
    grantPerson(botAccountId, userId) {
      ensureBot(botAccountId).people.add(String(userId));
      return this.snapshot();
    },
    revokePerson(botAccountId, userId) {
      state.get(String(botAccountId ?? ''))?.people.delete(String(userId));
      return this.snapshot();
    },
    grantGroup(botAccountId, groupId) {
      ensureBot(botAccountId).groups.add(String(groupId));
      return this.snapshot();
    },
    revokeGroup(botAccountId, groupId) {
      state.get(String(botAccountId ?? ''))?.groups.delete(String(groupId));
      return this.snapshot();
    },
    snapshot() {
      return {
        platform: currentPlatform,
        bots: Object.fromEntries(
          [...state.entries()].map(([bot, entry]) => [bot, {
            groups: [...entry.groups].sort(),
            people: [...entry.people].sort()
          }])
        )
      };
    },
    replace(next) {
      if (!next || typeof next !== 'object') fail(ERROR_CODES.INVALID_INPUT, '策略必须是对象');
      currentPlatform = String(next.platform ?? currentPlatform);
      state = normalizeBots(next.bots ?? {});
      this.platform = currentPlatform;
      return this.snapshot();
    }
  };
}