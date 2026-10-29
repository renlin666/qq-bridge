export function activate(ctx) {
  ctx.tools.register('qq_search_song', (args, call) => call.service('singing.generate', { action: 'search', ...args }));
  ctx.tools.register('qq_generate_singing', (args, call) => call.service('singing.generate', { action: 'generate', ...args }));
  ctx.tools.register('qq_get_singing', (args, call) => call.service('singing.generate', { action: 'status', ...args }));
}
