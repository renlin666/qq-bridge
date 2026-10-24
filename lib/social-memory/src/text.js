import crypto from 'node:crypto';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_RE = /[\p{L}\p{N}]+/gu;

const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '这', '那', '一个', '一下', '就是', '然后', '因为', '所以', '但是', '而且',
  '什么', '怎么', '可以', '还是', '已经', '没有', '不是', '这个', '那个',
  'the', 'a', 'an', 'to', 'of', 'and', 'is', 'are', 'was', 'were', 'it',
  'i', 'you', 'he', 'she', 'we', 'they', 'this', 'that', 'for', 'with'
]);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round1(value) {
  return Math.round(value * 10) / 10;
}

/** NFKC 仅用于比较/别名归一，不改变保存的原文。 */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u0000-\u001f]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 80);
}

/** 展示文本清理；记忆正文保留原文，不使用这个函数做检索。 */
export function cleanDisplayName(value, fallback = '') {
  const text = String(value ?? '')
    .replace(/[\r\n\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return text || fallback;
}

export function cleanText(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function hashText(value) {
  // 单独函数避免调用点散落算法。
  return createHashHex(value);
}

function createHashHex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * 轻量中文 bigram + 拉丁词。不是语义模型，只是可解释的关键词召回。
 * 返回去重后的数组；用于索引关键词和检索打分。
 */
export function tokenize(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const out = [];
  const push = (token) => {
    if (!token || STOPWORDS.has(token)) return;
    if (token.length < 2 && !CJK.test(token)) return;
    out.push(token);
  };

  // 连续文字切段后，对中文产生 bigram；英文/数字按词。
  for (const part of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    if (CJK.test(part)) {
      const chars = Array.from(part);
      if (chars.length === 1) push(chars[0]);
      for (let i = 0; i < chars.length - 1; i += 1) push(chars[i] + chars[i + 1]);
    } else {
      for (const word of part.match(WORD_RE) ?? []) push(word);
    }
  }
  return [...new Set(out)].slice(0, 80);
}

/** 生成 8～14 个稳定关键词，供本地检索和上游索引共用。 */
export function keywordsFrom(content, extra = []) {
  const counts = new Map();
  for (const token of tokenize(content)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of extra.flatMap((item) => tokenize(item))) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([token]) => token)
    .slice(0, 14);
}

export function normalizeKeywords(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))]
    .slice(0, 24);
}

export function truncateChars(value, max) {
  const chars = Array.from(String(value ?? ''));
  if (chars.length <= max) return String(value ?? '');
  if (max <= 1) return chars.slice(0, max).join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}

export function charLength(value) {
  return Array.from(String(value ?? '')).length;
}

/** 以本地日界作为“每日上限”的窗口，不依赖服务器时区之外的规则。 */
export function startOfLocalDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}