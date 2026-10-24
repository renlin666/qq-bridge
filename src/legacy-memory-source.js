// Old conversation summaries are data, never evidence of a person's QQ identity.
export function legacyMemoryEntries(state = {}, shared = [], now = Date.now()) {
  const entries = [];
  const add = (origin, content, sourceId = content) => {
    const text = String(content ?? '').trim();
    if (text) entries.push({ origin, sourceId: String(sourceId), content: text });
  };
  for (const item of state.activeTopics ?? []) {
    if (item?.text) add('legacy-topic', item.text + (item.pendingQuestion ? `；待追问：${item.pendingQuestion}` : ''));
  }
  for (const item of state.pendingThoughts ?? []) {
    if (item?.text && (!item.expiresAt || now < Number(item.expiresAt))) add('legacy-thought', item.text + (item.motivation ? `（${item.motivation}）` : ''));
  }
  for (const [name, impression] of Object.entries(state.memberImpressions ?? {})) {
    for (const trait of impression?.traits ?? []) add('legacy-impression', `${name}：${trait}`);
  }
  for (const item of shared) add('legacy-shared', `${item.name || '共同经历'}：${item.content}`, item.id);
  return entries;
}
