// Only the model-facing view is compacted. Stored messages and console/API data
// retain the original fields for display, media retrieval and troubleshooting.
const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward', 'directAtSelf'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds'
]);

const VIDEO_LINK = /https?:\/\/(?:[\w-]+\.)*(?:bilibili\.com\/video\/|b23\.tv\/|bili2233\.cn\/)[^\s<>"'\]]*/i;
const VIDEO_ID = /\b(?:BV[1-9A-HJ-NP-Za-km-z]{10}|av[1-9]\d{0,15})\b/i;
// Sharing metadata is visible without a mention. It is never viewing evidence.
export function videoMessageView(message) {
  if (!message || message.isSelf) return message;
  const source = ['text', 'plain', 'tail'].map(k => String(message[k] ?? '')).join('\n');
  const links = (message.sharedLinks ?? []).join('\n');
  if (!source.includes('[B站视频卡片') && !source.includes('[视频]')
      && !VIDEO_LINK.test(source + links) && !VIDEO_ID.test(source + links)) return message;
  return { ...message, videoWatch: { status: 'not-read', evidence: 'share-metadata-only' } };
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    // A local seq is a bridge message handle accepted by qq_get_message_images.
    // Forwarded nodes only have messageSeq, and may not be locally resolvable:
    // keep their transport references, even when they happen to have messageId.
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // Match the image tool's one-based ordering; never filter/reorder items.
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

export function compactModelMessage(message) {
  if (!isRecord(message)) return message;
  const result = { ...videoMessageView(message) };
  // Trusted routing metadata stays local; the model already knows its own identity.
  delete result.botAccountId;
  // No trimming or truncation: differing plain text can contain resolved quote
  // context, and tail can carry the end of a long message absent from text.
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (key === 'directAtSelf' && result.videoWatch) continue;
    if (result[key] === false) delete result[key];
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  return result;
}

export function compactModelData(data) {
  if (Array.isArray(data)) return data.map(compactModelData);
  if (!isRecord(data)) return data;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    (key === 'messages' || key === 'newMessages') && Array.isArray(value)
      ? value.map(compactModelMessage)
      : key === 'info' && isRecord(value) ? compactModelData(videoMessageView(value))
      : (key === 'recentMessages' || key === 'recent') && Array.isArray(value) ? value.map(videoMessageView)
      : compactModelData(value)
  ]));
}

export function serializeModelData(data) {
  return JSON.stringify(compactModelData(data));
}
