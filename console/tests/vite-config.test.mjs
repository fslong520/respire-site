import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import config from '../vite.config.js';

function withEnv(values, run) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
    run();
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

test('mode is explicit and each build has a separate output', () => {
  withEnv({ CF_PAGES: undefined, VITE_API_BASE_URL: undefined }, () => {
    for (const mode of ['dashboard', 'admin']) {
      const resolved = config({ mode });
      assert.equal(resolved.define['import.meta.env.VITE_CONSOLE_TARGET'], JSON.stringify(mode));
      assert.equal(resolved.define['import.meta.env.VITE_API_BASE_URL'], '"https://api.rsrs.rs"');
      assert.equal(resolved.build.outDir, fileURLToPath(new URL(`../dist/${mode}`, import.meta.url)));
    }
    assert.throws(() => config({ mode: 'production' }), /explicit dashboard or admin/);
  });
});

test('Cloudflare previews fail closed against the production API', () => {
  withEnv({ CF_PAGES: '1', CF_PAGES_BRANCH: 'feature/test', VITE_API_BASE_URL: undefined }, () => {
    assert.throws(() => config({ mode: 'dashboard' }), /isolated VITE_API_BASE_URL/);
  });
  withEnv({ CF_PAGES: '1', CF_PAGES_BRANCH: 'feature/test', VITE_API_BASE_URL: 'https://isolated-api.example.invalid' }, () => {
    assert.equal(config({ mode: 'admin' }).define['import.meta.env.VITE_API_BASE_URL'], '"https://isolated-api.example.invalid"');
  });
  withEnv({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main', VITE_API_BASE_URL: undefined }, () => {
    assert.equal(config({ mode: 'admin' }).define['import.meta.env.VITE_API_BASE_URL'], '"https://api.rsrs.rs"');
  });
});


test('Pages builds cannot point at a user loopback API', () => {
  for (const origin of ['http://127.0.0.1:4000', 'https://127.0.0.1:4000', 'https://localhost', 'https://test.localhost', 'https://localhost.', 'https://test.localhost.', 'https://[::ffff:127.0.0.1]', 'https://[::1]', 'https://192.0.2.1']) {
    withEnv({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main', VITE_API_BASE_URL: origin }, () => {
      assert.throws(() => config({ mode: 'dashboard' }), /remote HTTPS API hostname/);
    });
  }
});
