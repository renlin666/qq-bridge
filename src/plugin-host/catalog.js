import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const EXTENSION_API_VERSION = 1;
export const BUILTIN_IDS = Object.freeze(['bilibili', 'image-search', 'quark', 'qzone']);
export const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const TOOL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const clone = value => JSON.parse(JSON.stringify(value));

export function extensionConfig(id, cfg) {
  const entry = cfg.extensions?.[id];
  const legacy = id === 'image-search' ? {} : cfg.integrations?.[id] ?? {};
  return { ...clone(legacy), ...clone(entry?.config ?? {}), ...(BUILTIN_IDS.includes(id) && typeof entry?.enabled === 'boolean' ? { enabled: entry.enabled } : {}) };
}

export function extensionEnabled(id, cfg) {
  const entry = cfg.extensions?.[id];
  if (entry?.enabled === false) return false;
  if (entry?.enabled === true) return true;
  if (id === 'bilibili') return cfg.integrations?.bilibili?.enabled !== false;
  if (id === 'image-search') return true; // The service enforces per-tool search/send switches.
  if (id === 'quark' || id === 'qzone') return cfg.integrations?.[id]?.enabled === true;
  return false;
}

export function schemaFor(jsonSchema, { strict = true } = {}) {
  if (!jsonSchema || jsonSchema.type !== 'object') throw new Error('工具/配置 schema 必须为 object');
  return z.fromJSONSchema({ ...jsonSchema, ...(strict ? { additionalProperties: false } : {}) });
}

// Read metadata only. Merely placing a directory here never executes its entrypoint.
export function discoverExtensions(root, cfg, { localRoot = path.join(root, 'extensions-local') } = {}) {
  const ids = [...new Set([...BUILTIN_IDS, ...Object.keys(cfg.extensions ?? {})])];
  return ids.map(id => {
    try {
      if (!ID_RE.test(id)) throw new Error('插件 ID 格式无效');
      if (!extensionEnabled(id, cfg)) return { id, status: 'disabled' };
      const base = fs.realpathSync(BUILTIN_IDS.includes(id) ? path.join(root, 'extensions') : localRoot);
      const directory = fs.realpathSync(path.join(base, id));
      if (!directory.startsWith(base + path.sep)) throw new Error('插件目录越界');
      const manifestFile = fs.realpathSync(path.join(directory, 'plugin.json'));
      if (!manifestFile.startsWith(directory + path.sep)) throw new Error('插件清单越界');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest.id !== id || manifest.apiVersion !== EXTENSION_API_VERSION) throw new Error('插件 ID/API 版本不兼容');
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('插件版本无效');
      if (!Array.isArray(manifest.capabilities) || !Array.isArray(manifest.tools)) throw new Error('插件能力/工具清单无效');
      const grants = BUILTIN_IDS.includes(id) ? manifest.capabilities : cfg.extensions[id].capabilities ?? [];
      if (!Array.isArray(grants) || grants.some(name => typeof name !== 'string')) throw new Error('插件能力授权必须是字符串数组');
      if (manifest.capabilities.some(name => typeof name !== 'string' || !grants.includes(name))) throw new Error('插件所需能力未获管理员授权');
      const entry = fs.realpathSync(path.resolve(directory, manifest.entry ?? 'index.js'));
      if (!entry.startsWith(directory + path.sep)) throw new Error('插件入口越界');
      const toolNames = new Set();
      const actions = new Set();
      for (const tool of manifest.tools) {
        if (!TOOL_RE.test(tool.name) || toolNames.has(tool.name) || typeof tool.description !== 'string') throw new Error('工具名称重复或定义无效');
        toolNames.add(tool.name);
        if (!BUILTIN_IDS.includes(id) && !tool.name.startsWith('qq_ext_' + id.replaceAll('-', '_') + '_')) throw new Error('第三方工具必须使用 qq_ext_<插件ID>_ 命名空间');
        if (tool.action) {
          if (!ID_RE.test(tool.action) || actions.has(tool.action)) throw new Error('兼容接口名称重复或无效');
          actions.add(tool.action);
        }
        if (tool.timeoutMs != null && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 600000)) throw new Error('工具超时应为 1～600000 毫秒');
        if (['key', 'token'].some(name => Object.hasOwn(tool.inputSchema?.properties ?? {}, name))) throw new Error('工具参数不能覆盖 key/token');
        schemaFor(tool.inputSchema);
      }
      if (manifest.configSchema) schemaFor(manifest.configSchema, { strict: false }).parse(extensionConfig(id, cfg));
      return { id, status: 'discovered', manifest, directory, entry };
    } catch (error) { return { id, status: 'failed', error: String(error.message).slice(0, 300) }; }
  });
}

export function catalogFromDisk(root, cfg) {
  return discoverExtensions(root, cfg).filter(row => row.status === 'discovered')
    .flatMap(row => row.manifest.tools.map(tool => ({ ...tool, pluginId: row.id })));
}
