import { z } from 'zod';
import { catalogFromDisk, schemaFor } from './plugin-host/catalog.js';

// Tool metadata comes from the same manifests the bridge host validates.
// The MCP process never imports or executes extension entrypoints.
export function registerProjectExtensionTools(server, agentApi, cfg, root, catalog = catalogFromDisk(root, cfg)) {
  for (const definition of catalog) {
    const input = schemaFor(definition.inputSchema);
    server.tool(definition.name, definition.description, {
      key: z.string().regex(/^(group|private):[1-9]\d*$/).describe('当前来源会话 key'),
      token: z.string().min(1).describe('当前来源会话令牌'),
      ...input.shape,
    }, async ({ key, token, ...args }) => {
      try {
        return await agentApi('/api/socialV2/extensions/call', {
          method: 'POST', headers: { 'x-agent-token': token }, timeoutMs: (definition.timeoutMs ?? 60000) + 5000,
          body: JSON.stringify({ key, name: definition.name, arguments: args }),
        });
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] };
      }
    });
  }
}
