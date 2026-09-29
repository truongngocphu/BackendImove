const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('VPS env uses fixed public Core URL and disables discovery', () => {
  const env = read('deploy/.env.vps.example');
  assert.match(env, /^NODE_ENV=production$/m);
  assert.match(env, /^HOST=127\.0\.0\.1$/m);
  assert.match(env, /^PORT=5050$/m);
  assert.match(env, /^CORE_PUBLIC_URL=https:\/\/backendimove\.daututh79\.com$/m);
  assert.match(env, /^LAN_DISCOVERY_ENABLED=false$/m);
  assert.match(env, /^SERVICE_REGISTRY_ENABLED=false$/m);
  assert.match(env, /^CORS_ORIGINS=https:\/\/imove\.daututh79\.com$/m);
});

test('Nginx proxies public backend domain to loopback Node service', () => {
  const nginx = read('deploy/nginx-backendimove.conf.example');
  assert.match(nginx, /server_name backendimove\.daututh79\.com;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:5050;/);
  assert.match(nginx, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
});

test('Core exposes stable VPS health endpoints', () => {
  const server = read('src/server.js');
  assert.match(server, /app\.get\('\/live'/);
  assert.match(server, /app\.get\('\/health'/);
  assert.match(server, /app\.get\('\/ready'/);
  assert.match(server, /service: 'TH79_IMOVE_CORE'/);
});
