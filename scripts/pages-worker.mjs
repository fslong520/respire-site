// consoleHosts is generated from the same public origins as homepage links.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = consoleHosts[url.hostname];
    if (!target) return env.ASSETS.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Frontend requests must use the configured API origin', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/build-info.json') {
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({ ...consoleBuild, target }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' },
      });
    }
    const prefix = '/__console';
    if (url.pathname === '/source-notice.json' || url.pathname.startsWith('/licenses/') || /^\/[A-Za-z0-9_-]+\.woff2$/.test(url.pathname)) {
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
