import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { authPayload } from '../src/crypto.js';

// These values are deliberately synthetic. This server never contacts a real API,
// mailbox, database, or TOTP service; all state disappears when the test ends.
export const FIXTURE = Object.freeze({
  user: 'fixture-user',
  admin: 'fixture-admin',
  password: 'fixture-password-only',
  userToken: 'fixture-user-token',
  secondUser: 'fixture-second-user',
  secondToken: 'fixture-second-token',
  adminToken: 'fixture-admin-token',
  email: 'fixture@example.invalid',
  emailCode: '123456',
  totpCode: '654321',
});

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

export async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

export async function startFixtureApi({ frontend } = {}) {
  const origins = new Set();
  const requests = [];
  const unexpected = [];
  const userAuth = await authPayload(FIXTURE.user, FIXTURE.password);
  const secondAuth = await authPayload(FIXTURE.secondUser, FIXTURE.password);
  const adminAuth = await authPayload(FIXTURE.admin, FIXTURE.password);
  const state = {};
  function reset() {
    Object.assign(state, {
      failures: new Map(),
      rotatedToken: null,
      selfGates: new Map(),
      memoriesGate: null,
      userTotp: false,
      adminTotp: false,
      adminRole: 'owner',
      registered: false,
      email: '',
      emailVerified: false,
      pendingEmail: '',
      vault: null,
      blobs: new Map(),
      revision: 0,
      userTicket: 'fixture-user-ticket',
      adminTicket: 'fixture-admin-ticket',
      cliDecision: 'pending',
      github: { bound: false },
      githubState: 'a'.repeat(64),
    });
  }
  reset();
  const server = createServer(async (request, response) => {
    try {
      // The embedded console is served from the API origin and calls it with
      // same-origin relative paths; the optional frontend handler answers UI
      // paths (SPA HTML, fonts) without recording them as API traffic.
      if (frontend && await frontend(request, response, new URL(request.url, 'http://fixture.invalid'))) return;
      const url = new URL(request.url, 'http://fixture.invalid');
      const path = url.pathname;
      const method = request.method;
      const origin = request.headers.origin;
      const record = { method, path, search: url.search, origin, headers: request.headers, body: undefined };
      requests.push(record);
      const json = (status, body) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      try {
        // Only explicitly registered frontend origins may reach this API.
        if (!origins.has(origin)) {
          unexpected.push(`Cross-origin fixture API request from ${origin}: ${method} ${path}`);
          return json(403, { error: 'fixture origin not allowed' });
        }
        assert.equal(request.headers.cookie, undefined, 'API transport must omit browser cookies');
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Cache-Control', 'no-store');
        if (method === 'OPTIONS') {
          // Native browser preflights must carry only the supported API headers.
          const requestedMethod = request.headers['access-control-request-method'];
          assert.ok(['GET', 'POST'].includes(requestedMethod));
          const headers = (request.headers['access-control-request-headers'] || '').split(',').map(h => h.trim()).filter(Boolean);
          assert.ok(headers.every(h => ['authorization', 'content-type'].includes(h)));
          response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          response.setHeader('Access-Control-Max-Age', '0');
          return response.writeHead(204).end();
        }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      record.body = raw ? JSON.parse(raw) : undefined;
      const body = record.body || {};
      const failure = state.failures.get(`${method} ${path}`);
      if (failure) {
        if (failure.raw !== undefined) return response.writeHead(failure.status, { 'Content-Type': 'text/plain' }).end(failure.raw);
        return json(failure.status, { error: failure.error });
      }
      if (method === 'GET' && path === '/auth/salt') {
        const auth = url.searchParams.get('kind') === 'admin' ? adminAuth
          : url.searchParams.get('user') === FIXTURE.secondUser ? secondAuth : userAuth;
        assert.equal(url.searchParams.get('user'), auth.user);
        assert.equal(request.headers.authorization, undefined);
        return json(200, { salt: auth.salt });
      }
      if (method === 'POST' && path === '/oauth/github/start') {
        assert.equal(request.headers.authorization, undefined);
        return json(200, { state: state.githubState, expires_in: 600,
          authorization_uri: `${origin}/dashboard?code=fixture-github-code&state=${state.githubState}` });
      }
      if (method === 'POST' && path === '/oauth/github/exchange') {
        assert.equal(request.headers.authorization, undefined);
        assert.deepEqual(body, { state: state.githubState, code: 'fixture-github-code' });
        if (state.userTotp) return json(200, { user: FIXTURE.user, totp_required: true, ticket: state.userTicket });
        return json(200, { user: FIXTURE.user, token: FIXTURE.userToken });
      }
      if (method === 'POST' && ['/login', '/admin/login'].includes(path)) {
        const admin = path.startsWith('/admin');
        const auth = admin ? adminAuth : body.user === secondAuth.user ? secondAuth : userAuth;
        assert.equal(request.headers['content-type'], 'application/json');
        assert.equal(request.headers.authorization, undefined, 'Login must not reuse stored bearer tokens');
        if (body.user !== auth.user || body.pass_hash !== auth.pass_hash) return json(401, { error: 'fixture invalid credentials' });
        assert.equal(body.password, undefined, 'Passwords must be hashed before transit');
        if (!admin) assert.equal(body.device_name, 'dashboard');
        if (state[admin ? 'adminTotp' : 'userTotp']) return json(200, { totp_required: true, ticket: state[admin ? 'adminTicket' : 'userTicket'] });
        return json(200, { token: admin ? FIXTURE.adminToken : auth === secondAuth ? FIXTURE.secondToken : FIXTURE.userToken });
      }
      if (method === 'POST' && ['/login/totp', '/admin/login/totp'].includes(path)) {
        const admin = path.startsWith('/admin');
        const key = admin ? 'adminTicket' : 'userTicket';
        assert.equal(body.ticket, state[key]);
        assert.equal(request.headers.authorization, undefined);
        if (admin && body.code === '222222') {
          state[key] = 'fixture-admin-replacement-ticket';
          return json(200, { totp_required: true, ticket: state[key] });
        }
        if (body.code !== FIXTURE.totpCode) return json(401, { error: 'fixture invalid second factor' });
        if (!admin) assert.equal(body.device_name, 'dashboard');
        return json(200, { token: admin ? FIXTURE.adminToken : FIXTURE.userToken });
      }
      if (method === 'POST' && path === '/register') {
        assert.deepEqual(body, { ...userAuth, device_name: 'dashboard' });
        state.registered = true;
        return json(200, { token: FIXTURE.userToken });
      }
      const admin = path.startsWith('/admin/');
      const second = request.headers.authorization === `Bearer ${FIXTURE.secondToken}`;
      const expectedToken = admin ? FIXTURE.adminToken : second ? FIXTURE.secondToken : (state.rotatedToken || FIXTURE.userToken);
      if (request.headers.authorization !== `Bearer ${expectedToken}`) return json(admin ? 403 : 401, { error: admin ? 'admin token required' : 'fixture expired session' });
      if (method === 'GET' && path === '/api/self') {
        await state.selfGates.get(expectedToken);
        return json(200, { user: second ? FIXTURE.secondUser : FIXTURE.user, active: state.blobs.size });
      }
      if (method === 'POST' && path === '/api/self/rotate') {
        state.rotatedToken = 'fixture-rotated-token';
        return json(200, { token: state.rotatedToken });
      }
      if (method === 'GET' && path === '/api/self/sessions') return json(200, { sessions: [{ id: 'fixture-session', device_name: 'fixture-browser', created_at: '2026-01-01T00:00:00Z', current: true }] });
      if (method === 'GET' && path === '/api/self/keys') return json(200, { email: state.email, email_verified: state.emailVerified, totp: state.userTotp });
      if (method === 'GET' && path === '/api/self/github') return json(200, state.github);
      if (method === 'POST' && path === '/api/self/github/start') return json(200, { state: state.githubState, expires_in: 600,
        authorization_uri: `${origin}/dashboard?code=fixture-github-code&state=${state.githubState}` });
      if (method === 'POST' && path === '/api/self/github/exchange') {
        assert.deepEqual(body, { state: state.githubState, code: 'fixture-github-code' });
        state.github = { bound: true, id: 42, login: 'fixture-github' };
        return json(200, state.github);
      }
      if (method === 'POST' && path === '/api/self/github/unbind') {
        state.github = { bound: false };
        return json(200, state.github);
      }
      if (['/api/self/totp/begin', '/admin/totp/begin'].includes(path) && method === 'POST') {
        return json(200, { secret: 'JBSWY3DPEHPK3PXP', otpauth: 'otpauth://totp/respire:fixture?secret=JBSWY3DPEHPK3PXP&issuer=respire&period=30&digits=6' });
      }
      if (['/api/self/totp/confirm', '/admin/totp/confirm'].includes(path) && method === 'POST') {
        if (body.code !== FIXTURE.totpCode) return json(400, { error: 'fixture invalid second factor' });
        state[path.startsWith('/admin') ? 'adminTotp' : 'userTotp'] = true;
        return json(200, { ok: true });
      }
      if (path === '/api/self/totp/disable' && method === 'POST') {
        if (body.code !== FIXTURE.totpCode) return json(400, { error: 'fixture invalid second factor' });
        state.userTotp = false;
        return json(200, { ok: true });
      }
      if (path === '/api/self/cli-authorization/ABCDEF123456') {
        if (method === 'GET') return json(200, { device_name: 'fixture-terminal', expected_user: FIXTURE.user, expires_in: 600, state: state.cliDecision });
        assert.equal(method, 'POST');
        assert.equal(typeof body.approve, 'boolean');
        assert.equal(state.cliDecision, 'pending');
        state.cliDecision = body.approve ? 'approved' : 'denied';
        return json(200, { ok: true });
      }
      if (method === 'GET' && /^\/api\/self\/cli-authorization\/[A-Fa-f0-9]{12}$/.test(path)) return json(404, { error: 'fixture authorization code not found' });
      if (path === '/api/self/vault') {
        if (method === 'POST') {
          assert.equal(body.version, 4);
          assert.match(body.wrapped_urk, /^rsrs:v1:[0-9a-f]{96}$/);
          assert.match(body.urk_nonce, /^[0-9a-f]{24}$/);
          assert.match(body.kdf_salt, /^[0-9a-f]{32}$/);
          state.vault = body;
          return json(200, { ok: true });
        }
        if (method === 'GET') return state.vault ? json(200, state.vault) : json(404, { error: 'fixture vault not initialized' });
      }
      if (method === 'POST' && path === '/api/self/github/vault') {
        if (state.vault || state.blobs.size) return json(409, { error: 'existing vault or memories must be preserved' });
        assert.equal(body.version, 4);
        state.vault = body;
        return json(200, { ok: true });
      }
      if (method === 'GET' && path === '/pull') {
        const since = Number(url.searchParams.get('since') || 0);
        return json(200, { cursor: state.revision, blobs: [...state.blobs.values()].filter(blob => blob.revision > since) });
      }
      if (method === 'GET' && path === '/sync/capabilities') {
        return json(200, { epoch: 'fixture-epoch', protocols: [1, 2] });
      }
      if (method === 'GET' && path === '/api/self/memories') {
        await state.memoriesGate;
        const after = Number(url.searchParams.get('after'));
        const until = Number(url.searchParams.get('until') ?? state.revision);
        const rows = [...state.blobs.values()].filter(blob => blob.revision > after && blob.revision <= until)
          .sort((a, b) => a.revision - b.revision);
        const blobs = rows.slice(0, 100);
        const has_more = rows.length > blobs.length;
        const cursor = has_more ? blobs.at(-1).revision : until;
        return json(200, { epoch: 'fixture-epoch', cursor, until, has_more, blobs });
      }
      if (method === 'POST' && path === '/push') {
        assert.match(body.ciphertext, /^rsrs:v1:[0-9a-f]+$/);
        assert.match(body.nonce, /^[0-9a-f]{24}$/);
        assert.equal(body.embedding_enc, '');
        assert.equal(body.deleted, false);
        state.blobs.set(body.id, { ...body, revision: ++state.revision });
        return json(200, { ok: true });
      }
      if (method === 'POST' && path === '/api/self/email') {
        assert.equal(body.email, FIXTURE.email);
        state.pendingEmail = body.email;
        return json(200, { ok: true });
      }
      if (method === 'POST' && path === '/api/self/email/confirm') {
        if (body.code !== FIXTURE.emailCode) return json(400, { error: 'fixture invalid email code' });
        state.email = state.pendingEmail;
        state.emailVerified = true;
        return json(200, { ok: true });
      }
      if (method === 'GET' && path === '/admin/me') return json(200, { user: FIXTURE.admin, role: state.adminRole, kind: 'super_admin', totp: state.adminTotp });
      if (method === 'GET' && path === '/admin/stats') {
        if (state.adminRole === 'viewer') return json(403, { error: 'forbidden' });
        const rawDays = url.searchParams.get('days');
        const days = rawDays === null ? 30 : Number(rawDays);
        if ((rawDays !== null && !/^\+?\d+$/.test(rawDays.trim())) || !Number.isInteger(days) || days < 7 || days > 90) {
          return json(400, { error: 'days must be an integer between 7 and 90' });
        }
        const today = Date.UTC(2026, 9, 6);
        const series = Array.from({ length: days }, (_, i) => {
          const date = new Date(today - (days - i - 1) * 86400000).toISOString().slice(0, 10);
          return { date, registrations: i % 3, memories: date < '2026-10-05' ? null : 2, sessions: i % 4 };
        });
        return json(200, { days, timezone: 'Asia/Shanghai', memory_tracking_since: '2026-10-05', historical_baseline: 'retained_registrations_and_sessions', series });
      }
      if (method === 'GET' && path === '/admin/users') return json(200, { users: [{ user: FIXTURE.user, active: 0, session_count: 1, created_at: '2026-01-01T00:00:00Z' }], total: 1, page: 1, summary: { all: 1, ok: 1, banned: 0, deleted: 0, sessions: 1, ciphertext: 0 } });
      if (method === 'GET' && path === '/admin/admins') return json(200, { admins: [] });
      if (method === 'GET' && ['/admin/outbox', '/admin/audit'].includes(path)) return json(200, { items: [] });
      unexpected.push(`Unexpected API request: ${method} ${path}`);
      return json(404, { error: 'fixture route not implemented' });
      } catch (error) {
        unexpected.push(error.message);
        if (!response.headersSent) json(500, { error: 'fixture assertion failed' });
        else response.end();
      }
    } catch (error) {
      unexpected.push(`Fixture frontend failed: ${error.message}`);
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    }
  });
  const origin = await listen(server);
  return { origin, origins, requests, unexpected, state, reset, close: () => closeServer(server) };
}
