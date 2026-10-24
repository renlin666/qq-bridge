import { ERROR_CODES, fail } from './errors.js';

const ALLOWED_FIELDS = new Set(['memoryId', 'identity', 'scope', 'keywords', 'version', 'deleted']);
const FORBIDDEN_FIELDS = ['content', 'text', 'body', 'quote', 'evidence', 'sourceText'];

function assertIndexOnly(document) {
  if (!document || typeof document !== 'object') {
    fail(ERROR_CODES.INVALID_INPUT, '索引文档必须是对象');
  }
  for (const key of Object.keys(document)) {
    if (!ALLOWED_FIELDS.has(key)) {
      fail(ERROR_CODES.INDEX_REJECTED, `上游索引不允许字段：${key}`);
    }
  }
  for (const key of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(document, key)) {
      fail(ERROR_CODES.INDEX_REJECTED, `上游索引不能复制正文/证据：${key}`);
    }
  }
  if (typeof document.memoryId !== 'string' || !document.memoryId) {
    fail(ERROR_CODES.INVALID_INPUT, '索引文档缺少 memoryId');
  }
  if (!Number.isInteger(document.version) || document.version < 1) {
    fail(ERROR_CODES.INVALID_INPUT, '索引文档 version 必须是正整数');
  }
  if (!document.scope || typeof document.scope.type !== 'string' || typeof document.scope.id !== 'string') {
    fail(ERROR_CODES.INVALID_INPUT, '索引文档缺少 scope');
  }
  if (!document.identity
    || typeof document.identity.platform !== 'string'
    || typeof document.identity.botAccountId !== 'string') {
    fail(ERROR_CODES.INVALID_INPUT, '索引文档缺少 identity');
  }
  if (!Array.isArray(document.keywords)) {
    fail(ERROR_CODES.INVALID_INPUT, '索引文档 keywords 必须是数组');
  }
  if (typeof document.deleted !== 'boolean') {
    fail(ERROR_CODES.INVALID_INPUT, '索引文档 deleted 必须是布尔值');
  }
  return document;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 只存索引元数据的内存适配器。它不是 meow-memory 的真实接入；
 * 作用是把“上游只保留索引”的边界做成可执行接口，并模拟断网/重试。
 */
export class MockIndexAdapter {
  constructor({ online = true, failNext = 0 } = {}) {
    this.online = Boolean(online);
    this.failuresRemaining = Math.max(0, Number(failNext) || 0);
    this.documents = new Map();
    this.tombstones = new Map();
    this.operations = [];
    this.lastError = null;
  }

  setOnline(value) {
    this.online = Boolean(value);
    return this;
  }

  failNext(count = 1) {
    this.failuresRemaining = Math.max(0, Number(count) || 0);
    return this;
  }

  maybeFail(operation, document) {
    if (!this.online) {
      const error = new Error('模拟上游索引不可达');
      error.code = ERROR_CODES.UPSTREAM_OFFLINE;
      this.lastError = error.message;
      fail(ERROR_CODES.UPSTREAM_OFFLINE, '模拟上游索引不可达', { operation, memoryId: document.memoryId });
    }
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      fail(ERROR_CODES.UPSTREAM_OFFLINE, '模拟上游索引临时失败', { operation, memoryId: document.memoryId });
    }
  }

  async upsert(document) {
    assertIndexOnly(document);
    this.maybeFail('upsert', document);
    if (document.deleted) fail(ERROR_CODES.INDEX_REJECTED, 'upsert 不能携带删除标记');
    if (this.tombstones.has(document.memoryId)) {
      fail(ERROR_CODES.INDEX_REJECTED, '已删除索引不能通过旧 upsert 复活', {
        memoryId: document.memoryId,
        tombstoneVersion: this.tombstones.get(document.memoryId).version
      });
    }
    const current = this.documents.get(document.memoryId);
    if (current && current.version > document.version) {
      fail(ERROR_CODES.INDEX_REJECTED, '拒绝过期索引版本', {
        memoryId: document.memoryId,
        currentVersion: current.version
      });
    }
    if (current && current.version === document.version) {
      this.operations.push({ type: 'upsert-idempotent', memoryId: document.memoryId, version: document.version });
      return { unchanged: true, version: document.version };
    }
    this.documents.set(document.memoryId, clone(document));
    this.operations.push({ type: 'upsert', memoryId: document.memoryId, version: document.version });
    return { stored: true, version: document.version };
  }

  async delete(document) {
    assertIndexOnly(document);
    if (document.deleted !== true) fail(ERROR_CODES.INVALID_INPUT, 'delete 必须携带 deleted: true');
    this.maybeFail('delete', document);
    const existingTombstone = this.tombstones.get(document.memoryId);
    if (existingTombstone && existingTombstone.version >= document.version) {
      return { unchanged: true, version: existingTombstone.version };
    }
    this.documents.delete(document.memoryId);
    this.tombstones.set(document.memoryId, clone(document));
    this.operations.push({ type: 'delete', memoryId: document.memoryId, version: document.version });
    return { deleted: true, version: document.version };
  }

  get(memoryId) {
    const value = this.documents.get(String(memoryId));
    return value ? clone(value) : null;
  }

  list() {
    return [...this.documents.values()].map(clone).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  }

  deletedList() {
    return [...this.tombstones.values()].map(clone).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  }

  /** 测试辅助：确认没有任何正文/证据字段。 */
  inspectBodies() {
    return {
      documents: this.documents.size,
      tombstones: this.tombstones.size,
      containsBody: [...this.documents.values()].some((document) =>
        FORBIDDEN_FIELDS.some((key) => Object.hasOwn(document, key))
      )
    };
  }

  resetOperations() {
    this.operations = [];
  }
}

/**
 * 严格联动 meow-memory 的受控入口占位。当前没有已确认的、带 QQ 人物/会话
 * 权限隔离的上游 CRUD 接口，因此这里明确拒绝，不猜测 SQLite 结构、不联网。
 */
export function createDisabledMeowMemoryAdapter(reason = '当前未配置受控的 meow-memory 外部索引接口') {
  const refuse = async () => fail(ERROR_CODES.UPSTREAM_OFFLINE, reason, { adapter: 'meow-memory-disabled' });
  return {
    kind: 'meow-memory-disabled-placeholder',
    upsert: refuse,
    delete: refuse,
    get() { return null; },
    list() { return []; },
    deletedList() { return []; },
    inspectBodies() { return { documents: 0, tombstones: 0, containsBody: false }; }
  };
}