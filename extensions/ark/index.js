export function activate(ctx) {
  ctx.tools.register('qq_synthesize_speech', (args, call) => call.service('ark.assist', { action: 'tts', ...args }));
  ctx.tools.register('qq_transcribe_voice', (args, call) => call.service('ark.assist', { action: 'asr', ...args }));
  ctx.tools.register('qq_compose_photo', (args, call) => call.service('ark.assist', { action: 'photo', ...args }), {
    toMcp(result) {
      const { data, mimeType, ...metadata } = result;
      return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType, data }] };
    }
  });
  ctx.tools.register('qq_generate_image', (args, call) => call.service('ark.assist', { action: 'image', ...args }), {
    toMcp(result) {
      const { data, mimeType, ...metadata } = result;
      return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType, data }] };
    }
  });
}
