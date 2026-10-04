// consoleHosts is generated from the same public origins as homepage links.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = consoleHosts[url.hostname];
    if (!target) return env.ASSETS.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Frontend requests must use the configured API origin', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const prefix = `/__console/${target}`;
    if (['/build-info.json', '/source-notice.json'].includes(url.pathname) || url.pathname.startsWith('/licenses/')) {
      url.pathname = prefix + url.pathname;
    } else {
      // Request the pretty asset path to avoid Pages' index.html canonical redirect.
      url.pathname = prefix + '/';
    }
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const response = new Response(asset.body, asset);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    return response;
  },
};
