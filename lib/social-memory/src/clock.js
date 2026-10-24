/**
 * 时间可注入：生产环境可直接传 Date.now 或 () => Date.now()；
 * 离线测试/demo 使用 ManualClock，推进时间不需要真的等待。
 */
export function createManualClock(initial = '2026-01-01T00:00:00.000Z') {
  let current = typeof initial === 'number' ? initial : Date.parse(initial);
  if (!Number.isFinite(current)) throw new TypeError('ManualClock 需要有效时间');
  return {
    now: () => current,
    advance(ms) {
      const delta = Number(ms);
      if (!Number.isFinite(delta) || delta < 0) throw new TypeError('advance 需要非负毫秒数');
      current += delta;
      return current;
    },
    set(value) {
      const next = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(next)) throw new TypeError('set 需要有效时间');
      current = next;
      return current;
    }
  };
}

export function resolveNow(clock) {
  if (typeof clock === 'function') {
    const value = clock();
    if (!Number.isFinite(value)) throw new TypeError('clock() 必须返回毫秒时间戳');
    return Math.trunc(value);
  }
  if (clock && typeof clock.now === 'function') {
    const value = clock.now();
    if (!Number.isFinite(value)) throw new TypeError('clock.now() 必须返回毫秒时间戳');
    return Math.trunc(value);
  }
  if (Number.isFinite(clock)) return Math.trunc(clock);
  throw new TypeError('clock 必须是函数、Number 或带 now() 的对象');
}