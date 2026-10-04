import { requestViolation } from './hosted-split-contract.mjs';

// Use a separate raw CDP session, not context.route/page.route. Playwright's
// request-routing layer can synthesize successful preflight responses. The
// local browser-hosted-cors.mjs regression checks this exact guard against
// actual server-recorded OPTIONS and denied-origin behavior.
export async function installHostedBrowserGuard({ context, page, config, failures }) {
  let closing = false;
  const cdp = await context.newCDPSession(page);
  cdp.on('Fetch.requestPaused', async event => {
    const { requestId, request, resourceType, responseStatusCode, responseErrorReason } = event;
    const violation = requestViolation(config, request, resourceType)
      || (responseStatusCode >= 300 && responseStatusCode < 400 ? 'redirect-blocked' : null);
    try {
      if (violation) {
        failures.push(violation); // Categories only; no URLs, bodies, or headers.
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      } else if (responseStatusCode !== undefined || responseErrorReason !== undefined) {
        await cdp.send('Fetch.continueResponse', { requestId });
      } else {
        // Do not add headers/body/url overrides or use Playwright route handlers.
        await cdp.send('Fetch.continueRequest', { requestId, interceptResponse: true });
      }
    } catch {
      if (!closing) failures.push('interception-failed');
      try { await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); } catch {}
    }
  });
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await context.routeWebSocket('**/*', socket => {
    failures.push('websocket-blocked');
    socket.close();
  });
  context.on('page', extra => {
    if (extra !== page) {
      failures.push('unexpected-page');
      void extra.close().catch(() => {});
    }
  });
  return { beginClosing() { closing = true; } };
}
