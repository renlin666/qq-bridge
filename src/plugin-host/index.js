import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import { BUILTIN_IDS, discoverExtensions, extensionConfig, extensionEnabled, schemaFor, TOOL_RE } from './catalog.js';
import { createExtensionStorage } from './storage.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const copy = value => JSON.parse(JSON.stringify(value));
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value ?? null) }] });

export function createPluginHost({ root, stateDir, getConfig, services = {}, log = () => {},
  localRoot, activationTimeoutMs = 10000, hookTimeoutMs = 5000, reservedTools = [] }) {
  const rows = new Map();
  const tools = new Map();
  const actions = new Map();
  const reserved = new Set(reservedTools);
  let closed = false;

  function live(row) {
    if (closed || row.status !== 'active' || !extensionEnabled(row.id, getConfig())) fail('插件未启用或功能已关闭：' + row.id, 403);
    if (!BUILTIN_IDS.includes(row.id) && row.manifest.capabilities.some(name => !getConfig().extensions?.[row.id]?.capabilities?.includes(name))) fail('插件能力授权已撤销', 403);
  }
  async function cleanup(row) {
    for (const controller of row.calls) controller.abort();
    for (const fn of row.cleanup.splice(0).reverse()) {
      try { await fn(); } catch (error) { log('插件资源清理失败', row.id, error.message); }
    }
    for (const [name, item] of tools) if (item.row === row) tools.delete(name);
    for (const [name, item] of actions) if (item.row === row) actions.delete(name);
  }
  async function deadline(row, timeoutMs, work) {
    const controller = new AbortController();
    row.calls.add(controller);
    let timer;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('插件调用已取消或超时'), { statusCode: 504 })), { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted]); }
    finally { clearTimeout(timer); controller.abort(); row.calls.delete(controller); }
  }
  function scopeFor(row, scope, signal) {
    if (!scope || !/^(group|private):[1-9]\d*$/.test(scope.key) || typeof scope.assertAuthorized !== 'function') fail('插件调用缺少已认证会话', 403);
    const assertAuthorized = () => {
      if (signal.aborted) fail('插件调用已取消', 403);
      live(row); scope.assertAuthorized();
    };
    assertAuthorized();
    const requireCapability = name => {
      assertAuthorized();
      if (!row.manifest.capabilities.includes(name)) fail('插件能力未授权：' + name, 403);
    };
    return Object.freeze({
      key: scope.key, isOwner: scope.isOwner === true, messageId: scope.messageId ?? null, signal, assertAuthorized,
      messages: Object.freeze({
        get(messageId) { requireCapability('messages.read'); return copy(services.readMessage?.(scope.key, messageId) ?? null); },
        async send(messages, requestId) {
          requireCapability('messages.send');
          if (!/^[A-Za-z0-9_-]{8,100}$/.test(String(requestId ?? ''))) fail('发送需要稳定的 requestId（8～100位），重试复用');
          if (!services.sendMessage) fail('消息发送服务未就绪', 503);
          const scopedId = crypto.createHash('sha256').update(row.id + ':' + requestId).digest('hex');
          return services.sendMessage(scope.key, messages, scopedId, assertAuthorized);
        },
      }),
      async service(name, args) {
        requireCapability(name);
        const service = services[name];
        if (typeof service !== 'function') fail('插件服务未就绪：' + name, 503);
        const result = await service(scope.key, copy(args ?? {}), assertAuthorized, signal);
        assertAuthorized(); return result;
      },
    });
  }
  async function invoke(item, args, scope, mcp) {
    live(item.row);
    const validated = item.schema.safeParse(args ?? {});
    if (!validated.success) fail('插件参数无效：' + validated.error.message);
    const parsed = validated.data;
    return deadline(item.row, item.definition.timeoutMs ?? 60000, async signal => {
      const call = scopeFor(item.row, scope, signal);
      const result = await item.execute(parsed, call);
      call.assertAuthorized();
      return mcp ? item.format ? item.format(result) : Array.isArray(result?.content) ? result : textResult(result) : result;
    });
  }
  async function activate(descriptor) {
    const row = { ...descriptor, cleanup: [], calls: new Set(), events: new Map(), commands: new Map(), registered: [] };
    rows.set(row.id, row);
    if (row.status !== 'discovered') return;
    row.status = 'loading';
    const registering = () => { if (row.status !== 'loading') fail('插件注册期已结束'); };
    const context = Object.freeze({
      id: row.id, version: row.manifest.version,
      get config() { return copy(extensionConfig(row.id, getConfig())); },
      storage: createExtensionStorage(stateDir, row.id),
      dataDirectory: row.manifest.capabilities.includes('storage.sqlite') ? path.join(stateDir, 'extensions', row.id) : undefined,
      context: Object.freeze({ register(handler) {
        registering();
        if (!row.manifest.capabilities.includes('memory.context') || typeof handler !== 'function') fail('上下文能力未授权');
        row.contextProvider = handler;
      } }),
      log: (...args) => log('[extension:' + row.id + ']', ...args),
      tools: Object.freeze({ register(name, execute, { toMcp } = {}) {
        registering();
        const definition = row.manifest.tools.find(tool => tool.name === name);
        if (!definition || typeof execute !== 'function' || row.registered.some(tool => tool.definition.name === name)) fail('工具未声明或重复注册：' + name);
        row.registered.push({ row, definition, execute, format: toMcp, schema: schemaFor(definition.inputSchema) });
      } }),
      events: Object.freeze({ on(name, handler) {
        registering();
        if (name !== 'message' || typeof handler !== 'function' || !row.manifest.capabilities.includes('messages.read')) fail('事件未授权或无效');
        const handlers = row.events.get(name) ?? [];
        handlers.push(handler); row.events.set(name, handlers);
      } }),
      commands: Object.freeze({ register(name, handler, { allowMembers = false } = {}) {
        registering();
        if (!TOOL_RE.test(name) || row.commands.has(name) || typeof handler !== 'function') fail('命令名称无效或重复');
        row.commands.set(name, { handler, allowMembers: allowMembers === true });
      } }),
      scheduler: Object.freeze({ every(ms, handler) {
        registering();
        if (!Number.isInteger(ms) || ms < 1000 || typeof handler !== 'function' || !row.manifest.capabilities.includes('scheduler')) fail('定时任务未授权或间隔无效');
        let running = false;
        const timer = setInterval(async () => {
          if (running || row.status !== 'active' || !extensionEnabled(row.id, getConfig())) return;
          running = true;
          let work;
          try { await deadline(row, hookTimeoutMs, signal => {
            work = Promise.resolve().then(() => handler({ signal }));
            work.then(() => { running = false; }, () => { running = false; });
            return work;
          }); }
          catch (error) { log('插件定时任务失败', row.id, error.message); }
          finally { if (!work) running = false; }
        }, ms);
        timer.unref?.(); row.cleanup.push(() => clearInterval(timer));
      } }),
      onDispose(fn) { registering(); if (typeof fn !== 'function') fail('清理函数无效'); row.cleanup.push(fn); },
      // Trusted built-ins may use an explicitly granted background service; no raw bot/config is exposed.
      async background(name, args) {
        live(row);
        if (!row.manifest.capabilities.includes(name) || typeof services[name] !== 'function') fail('后台能力未授权', 403);
        return services[name](null, copy(args ?? {}), () => live(row));
      },
    });
    try {
      await deadline(row, activationTimeoutMs, async signal => {
        const module = await import(pathToFileURL(row.entry).href);
        if (signal.aborted) fail('插件加载已取消');
        if (typeof module.activate !== 'function') fail('插件必须导出 activate(ctx)');
        const dispose = await module.activate(context);
        if (typeof dispose === 'function') {
          if (signal.aborted) dispose(); else row.cleanup.push(dispose);
        }
        if (signal.aborted) fail('插件加载已取消');
      });
      if (row.registered.length !== row.manifest.tools.length) fail('插件未注册全部声明工具');
      for (const item of row.registered) {
        if (reserved.has(item.definition.name) || tools.has(item.definition.name)) fail('工具名称冲突：' + item.definition.name);
        if (item.definition.action && actions.has(item.definition.action)) fail('兼容接口冲突：' + item.definition.action);
      }
      row.status = 'active';
      for (const item of row.registered) {
        tools.set(item.definition.name, item);
        if (item.definition.action) actions.set(item.definition.action, item);
      }
    } catch (error) {
      row.status = 'failed'; row.error = String(error.message).slice(0, 300); await cleanup(row);
      log('插件加载失败，基础聊天继续运行', row.id, row.error);
    }
  }
  const ready = (async () => {
    for (const descriptor of discoverExtensions(root, getConfig(), { localRoot })) {
      if (closed) break;
      await activate(descriptor);
    }
  })();
  return Object.freeze({
    ready,
    async catalog() {
      await ready;
      return [...tools.values()].filter(item => item.row.status === 'active' && extensionEnabled(item.row.id, getConfig()))
        .map(item => ({ ...copy(item.definition), pluginId: item.row.id }));
    },
    async status() { await ready; return [...rows.values()].map(({ id, status, error, manifest }) => ({ id, status, version: manifest?.version, ...(error ? { error } : {}) })); },
    async describe() {
      await ready;
      const cfg = getConfig();
      const forced = { ...cfg, extensions: { ...cfg.extensions } };
      for (const id of rows.keys()) forced.extensions[id] = { ...forced.extensions[id], enabled: true };
      return discoverExtensions(root, forced, { localRoot }).map(item => ({
        id: item.id, version: item.manifest?.version, status: rows.get(item.id)?.status ?? item.status,
        error: rows.get(item.id)?.error ?? item.error, enabled: extensionEnabled(item.id, cfg),
        config: extensionConfig(item.id, cfg), configSchema: item.manifest?.configSchema,
        capabilities: item.manifest?.capabilities ?? [], tools: item.manifest?.tools.map(tool => tool.name) ?? [],
      }));
    },
    async validateConfig(id, config) {
      await ready;
      if (!rows.has(id)) fail('插件不存在');
      if (!config || typeof config !== 'object' || Array.isArray(config)) fail('插件配置必须是对象');
      const cfg = getConfig();
      const forced = { ...cfg, extensions: { ...cfg.extensions, [id]: { ...cfg.extensions?.[id], enabled: true, config } } };
      const descriptor = discoverExtensions(root, forced, { localRoot }).find(item => item.id === id);
      if (descriptor.status === 'failed') fail('插件配置无效：' + descriptor.error);
      return copy(config);
    },
    async callTool(name, args, scope) {
      await ready;
      const item = tools.get(name);
      if (!item) fail('插件工具未启用或不存在：' + name, 403);
      return invoke(item, args, scope, true);
    },
    async invokeAction(action, args, scope) {
      await ready;
      const item = actions.get(action);
      if (!item) return null;
      const { key: _key, ...parameters } = args;
      return invoke(item, parameters, scope, false);
    },
    async dispatchMessage(message, scope) {
      await ready;
      for (const row of rows.values()) {
        if (row.status !== 'active' || !extensionEnabled(row.id, getConfig())) continue;
        for (const handler of row.events.get('message') ?? []) {
          try { await deadline(row, hookTimeoutMs, signal => handler(copy(message), scopeFor(row, scope, signal))); }
          catch (error) { log('插件消息处理失败', row.id, error.message); }
        }
      }
    },
    async collectContext(request, scope) {
      await ready;
      const chunks = [];
      for (const row of rows.values()) {
        if (!row.contextProvider || row.status !== 'active' || !extensionEnabled(row.id, getConfig())) continue;
        try {
          const result = await deadline(row, hookTimeoutMs, signal => row.contextProvider(copy(request), scopeFor(row, scope, signal)));
          if (typeof result === 'string' && result) chunks.push(result.slice(0, 1200));
        } catch (error) { log('插件上下文生成失败', row.id, error.message); }
      }
      return chunks.join('\n').slice(0, 2000);
    },
    async dispatchCommand(text, scope) {
      await ready;
      const match = /^\/([a-z][a-z0-9-]*):([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match) return false;
      const row = rows.get(match[1]);
      const command = row?.commands.get(match[2]);
      if (!command) return false;
      try {
        if (!command.allowMembers && !scope.isOwner) fail('插件命令仅管理员可用', 403);
        await deadline(row, hookTimeoutMs, signal => command.handler(match[3] ?? '', scopeFor(row, scope, signal)));
      } catch (error) { error.pluginCommand = true; throw error; }
      return true;
    },
    async stop(id) { await ready; const row = rows.get(id); if (row) { row.status = 'disabled'; await cleanup(row); } },
    async close() { closed = true; await ready; for (const row of [...rows.values()].reverse()) { row.status = 'disabled'; await cleanup(row); } },
  });
}
