export function activate(ctx) {
  ctx.tools.register('qq_search_images', (args, call) => call.service('images.search', args), {
    toMcp(result) {
      const { previews = [], ...meta } = result;
      return { content: [{ type: 'text', text: JSON.stringify(meta) }, ...previews.map(image => ({ type: 'image', ...image }))] };
    },
  });
  ctx.tools.register('qq_send_image', (args, call) => call.service('images.send', args));
}
