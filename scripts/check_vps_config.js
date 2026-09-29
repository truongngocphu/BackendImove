require('dotenv').config();
const { assertProductionConfig } = require('../src/production_guard');

function value(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

try {
  if (value('NODE_ENV').toLowerCase() !== 'production') {
    throw new Error('NODE_ENV phải là production khi deploy VPS.');
  }
  assertProductionConfig();

  const host = value('HOST', '127.0.0.1');
  const port = Number(value('PORT', '5050'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT không hợp lệ.');

  const publicUrl = new URL(value('CORE_PUBLIC_URL'));
  if (publicUrl.protocol !== 'https:') throw new Error('CORE_PUBLIC_URL phải dùng HTTPS.');

  console.log('✅ VPS config hợp lệ');
  console.log(`   NODE_ENV       : ${value('NODE_ENV')}`);
  console.log(`   LISTEN          : ${host}:${port}`);
  console.log(`   CORE_PUBLIC_URL : ${publicUrl.origin}`);
  console.log(`   DATABASE        : ${value('MONGODB_DB', 'th79_imove')}`);
  console.log(`   MongoDB URI     : ${value('MONGODB_URI') ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`   LAN discovery   : ${value('LAN_DISCOVERY_ENABLED', 'false')}`);
  console.log(`   Service registry: ${value('SERVICE_REGISTRY_ENABLED', 'false')}`);
  console.log(`   Redis required  : ${value('REDIS_REQUIRED', 'false')}`);
  console.log(`   FCM required    : ${value('FCM_REQUIRED', 'false')}`);
} catch (error) {
  console.error('❌ VPS config chưa hợp lệ');
  console.error(error.message);
  process.exit(1);
}
