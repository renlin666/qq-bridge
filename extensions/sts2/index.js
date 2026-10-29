export function activate(ctx) {
  ctx.tools.register('qq_sts2_read', (args, call) => call.service('games.sts2', { operation: 'read', ...args }));
  ctx.tools.register('qq_sts2_control', (args, call) => call.service('games.sts2', { operation: 'control', ...args }));
  ctx.tools.register('qq_sts2_action', (args, call) => call.service('games.sts2', { operation: 'action', ...args }));
}
