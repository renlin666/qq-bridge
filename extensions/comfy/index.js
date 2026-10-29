export function activate(ctx) {
  ctx.tools.register('qq_generate_video', (args, call) => call.service('comfy.generate', { action: 'generate-video', ...args }));
  ctx.tools.register('qq_get_local_generation', (args, call) => call.service('comfy.generate', { action: 'status', ...args }), {
    toMcp(result) {
      const { data, mimeType, ...metadata } = result;
      return { content: [{ type: 'text', text: JSON.stringify(metadata) }, ...(data ? [{ type: 'image', mimeType, data }] : [])] };
    }
  });
  ctx.tools.register('qq_send_generated_video', (args, call) => call.service('comfy.generate', { action: 'send-video', ...args }));
}
