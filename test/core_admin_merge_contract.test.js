const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'src/admin_console_routes.js'), 'utf8');

test('Core mounts Admin Console routes in the same process', () => {
  assert.match(server, /createAdminConsoleRouter/);
  assert.match(server, /app\.use\(adminConsoleRouter\)/);
  assert.match(server, /ensureAdminRbacSeed/);
});

test('Admin Console exposes routes required by Vercel Admin', () => {
  for (const route of [
    '/api/health',
    '/api/bootstrap',
    '/api/admin-access/me',
    '/api/admin-management/bootstrap',
    '/api/admin-profile',
    '/api/admin-audit',
    '/api/data/:key',
  ]) {
    assert.ok(admin.includes(route), `missing ${route}`);
  }
});

test('sensitive Admin data routes require Admin access', () => {
  assert.match(admin, /router\.get\('\/api\/bootstrap', requireAdminAccess\(\)/);
  assert.match(admin, /router\.get\('\/api\/data\/:key', requireAdminAccess\(\)/);
  assert.match(admin, /router\.get\('\/api\/data\/settings', requireAdminAccess\('settings\.view'\)/);
});

test('merged Admin authentication verifies Core JWT locally', () => {
  assert.match(admin, /jwt\.verify\(token,jwtSecret\(\)\)/);
  assert.doesNotMatch(admin, /admin-gateway/);
  assert.doesNotMatch(admin, /127\.0\.0\.1:5060/);
});
