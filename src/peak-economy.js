import { isPeakAt, DEFAULT_PRICE_TABLE } from './model-prices.js';
import { videoMessageView } from './qq-model-view.js';

export const PEAK_ECONOMY_DEFAULTS = Object.freeze({
  enabled: false, mode: 'auto', probability: 0.2, minIntervalMs: 900000, replyChars: 80
});
const protectedReasons = new Set(['private', 'atMention', 'bootstrap', 'admin', 'poke', 'video']);

export function peakEconomyConfig(value) {
  const c = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = (key, min, max) => typeof c[key] === 'number' && Number.isFinite(c[key])
    && c[key] >= min && c[key] <= max ? c[key] : PEAK_ECONOMY_DEFAULTS[key];
  return { enabled: c.enabled === true, mode: ['auto', 'peak', 'off'].includes(c.mode) ? c.mode : 'auto',
    probability: number('probability', 0, 1), minIntervalMs: Math.round(number('minIntervalMs', 0, 86400000)),
    replyChars: Math.round(number('replyChars', 20, 500)) };
}

export function validatePeakEconomy(value, current) {
  const fail = () => { throw Object.assign(new Error('峰谷节流配置无效：请检查开关、模式、概率、间隔和建议字数'), { statusCode: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const merged = { ...peakEconomyConfig(current), ...value };
  if (Object.keys(value).some(key => !Object.hasOwn(PEAK_ECONOMY_DEFAULTS, key))
    || typeof merged.enabled !== 'boolean' || !['auto', 'peak', 'off'].includes(merged.mode)
    || !Number.isFinite(merged.probability) || merged.probability < 0 || merged.probability > 1
    || !Number.isInteger(merged.minIntervalMs) || merged.minIntervalMs < 0 || merged.minIntervalMs > 86400000
    || !Number.isInteger(merged.replyChars) || merged.replyChars < 20 || merged.replyChars > 500) fail();
  return merged;
}

export function peakEconomyStatus(value, now = Date.now(), table = DEFAULT_PRICE_TABLE) {
  const config = peakEconomyConfig(value);
  const peak = config.mode === 'peak' || (config.mode === 'auto' && isPeakAt(now, table));
  return { ...config, peak, active: config.enabled && peak, timeZone: 'Asia/Shanghai' };
}

// Decide once at dispatch, so an offline queue cannot carry an off-peak permit into peak hours.
export function decidePeakWake({ key, reason, unread = [], lastAcceptedAt = 0, config, now = Date.now(),
  table = DEFAULT_PRICE_TABLE, random = Math.random }) {
  const status = peakEconomyStatus(config, now, table);
  const protectedWake = key.startsWith('private:') || protectedReasons.has(String(reason).split(':')[0])
    || unread.some(message => message?.directAtSelf === true || message?.quoteTargetIsSelf === true
      || (!message?.isSelf && videoMessageView({ plain: message?.plain, sharedLinks: message?.sharedLinks }).videoWatch));
  if (!status.active || protectedWake) return { ...status, allowed: true, protectedWake };
  const last = Number(lastAcceptedAt);
  const elapsed = Number.isFinite(last) && last > 0 ? Math.max(0, now - last) : Infinity;
  const remaining = Math.max(0, status.minIntervalMs - elapsed);
  if (remaining > 0) return { ...status, allowed: false, reason: 'interval', retryAfterMs: remaining };
  const allowed = random() < status.probability;
  return { ...status, allowed, reason: allowed ? 'accepted' : 'probability', retryAfterMs: Math.max(60000, status.minIntervalMs) };
}
