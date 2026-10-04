import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'site/dist/pages');
const origins = {
  dashboard: process.env.VITE_DASHBOARD_URL || 'https://dash.rsrs.rs',
  admin: process.env.VITE_ADMIN_URL || 'https://admin.rsrs.rs',
};
for (const [target, value] of Object.entries(origins)) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${target} requires an HTTPS origin`);
  }
  origins[target] = url.origin;
}
if (origins.dashboard === origins.admin) throw new Error('Console origins must be distinct');
const inputs = { homepage: 'site/dist/client', dashboard: 'console/dist/dashboard', admin: 'console/dist/admin' };
const metadata = Object.fromEntries(Object.entries(inputs).map(([target, directory]) => {
  const value = JSON.parse(readFileSync(resolve(root, directory, 'build-info.json'), 'utf8'));
  if (value.target !== target) throw new Error(`Wrong ${target} build target`);
  return [target, value];
}));
if (metadata.homepage.base !== '/') throw new Error('Combined Pages requires the root homepage build');
if (new Set(Object.values(metadata).map(value => value.site_revision)).size !== 1) throw new Error('Build revisions differ');
if (metadata.dashboard.api_base_url !== metadata.admin.api_base_url) throw new Error('Console API origins differ');

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(resolve(root, inputs.homepage), output, { recursive: true });
for (const target of ['dashboard', 'admin']) {
  cpSync(resolve(root, inputs[target]), resolve(output, '__console', target), { recursive: true });
}
const template = readFileSync(new URL('./pages-worker.mjs', import.meta.url), 'utf8');
const hosts = Object.fromEntries(Object.entries(origins).map(([target, origin]) => [new URL(origin).hostname, target]));
writeFileSync(resolve(output, '_worker.js'), `const consoleHosts = ${JSON.stringify(hosts)};\n${template}`);
writeFileSync(resolve(output, 'pages-build.json'), JSON.stringify({ origins, builds: metadata }, null, 2) + '\n');
console.log('Assembled one Pages deployment: homepage root and two console hostnames.');
