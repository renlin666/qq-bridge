const MINUTE = 60000;
const REACTIONS = Object.freeze({
  banter: { label: '玩闹', ttl: 15 * MINUTE, guidance: '顺着当前梗补一个具体细节或反转，也可反将一军；不解释笑点、不复读叫好。' },
  annoyed: { label: '不耐烦', ttl: 10 * MINUTE, guidance: '可以短句反问、顶回去或暂时不搭理；不训话、不辱骂，不为了表演故意生气。' },
  conflict: { label: '不悦', ttl: 20 * MINUTE, guidance: '就这件事表达不满，可以怼一句后收住；高好感不等于顺从，别牵连别人。' },
  boundary_violation: { label: '警惕', ttl: 25 * MINUTE, guidance: '明确说不喜欢或拒绝这个玩笑；对方停下后别持续攻击。' },
  repair: { label: '缓和', ttl: 8 * MINUTE, guidance: '回应这次道歉或善意，可以留一点嘴硬，再自然接回话题；别持续翻旧账。' },
  serious: { label: '认真', ttl: 10 * MINUTE, guidance: '对方正在认真或已经不舒服，停止互损和抖机灵，直接回应当前事情。' }
});

export const TRANSIENT_KINDS = new Set(['banter', 'annoyed', 'repair', 'serious']);

// Reactions belong to one bot, conversation and person. No message bodies or
// private/global mood are injected across conversations; scores are untouched.
export function createReactions(storage, now = Date.now) {
  const keyFor = (bot, scope, user) => JSON.stringify([bot, scope, user]);
  function view(entry) {
    const reaction = entry?.reaction;
    const rule = REACTIONS[reaction?.kind];
    if (!rule || reaction.expiresAt <= now()) return null;
    return { kind: reaction.kind, label: rule.label,
      intensity: Math.round(10 * Math.min(1, (reaction.expiresAt - now()) / rule.ttl)) / 10,
      guidance: rule.guidance };
  }
  return {
    get(bot, scope, user) { return view(storage.get('reactions', {})[keyFor(bot, scope, user)]); },
    record(bot, scope, user, source, kind) {
      if (!REACTIONS[kind]) return null;
      const data = storage.get('reactions', {}), key = keyFor(bot, scope, user);
      const entry = data[key] ?? { seen: [] };
      entry.seen = entry.seen.filter(item => now() - item.at < 24 * 60 * MINUTE);
      if (entry.seen.some(item => item.id === source)) return { applied: false, duplicate: true, reaction: view(entry) };
      entry.seen = [...entry.seen, { id: source, at: now() }].slice(-32);
      entry.reaction = { kind, expiresAt: now() + REACTIONS[kind].ttl };
      entry.updatedAt = now(); data[key] = entry;
      const kept = Object.entries(data).filter(([, value]) => now() - value.updatedAt < 24 * 60 * MINUTE)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 256);
      storage.set('reactions', Object.fromEntries(kept));
      return { applied: true, duplicate: false, reaction: view(entry) };
    }
  };
}
