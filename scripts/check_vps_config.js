'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.resolve(process.cwd(), process.argv[2] || '.env');
const errors = [];
const warnings = [];

function mask(value) {
  if (!value) return '(empty)';
  if (value.length <= 6) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

if (!fs.existsSync(envPath)) {
  console.error(`[CONFIG] Không tìm thấy ${envPath}`);
  process.exit(2);
}

const raw = fs.readFileSync(envPath, 'utf8');
const parsed = dotenv.parse(raw);
const seen = new Map();
for (const rawLine of raw.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (!match) continue;
  const key = match[1];
  seen.set(key, (seen.get(key) || 0) + 1);
}
const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
if (duplicates.length) errors.push(`Biến .env bị khai báo lặp: ${duplicates.join(', ')}`);

const env = String(parsed.NODE_ENV || '').toLowerCase();
if (!['development', 'production'].includes(env)) warnings.push(`NODE_ENV=${parsed.NODE_ENV || '(empty)'} không chuẩn.`);
if (env !== 'production') warnings.push('VPS public hiện không chạy NODE_ENV=production.');
if (!/^https:\/\//i.test(String(parsed.CORE_PUBLIC_URL || ''))) warnings.push('CORE_PUBLIC_URL nên là HTTPS public URL.');
if (!/^mongodb(\+srv)?:\/\//i.test(String(parsed.MONGODB_URI || ''))) errors.push('MONGODB_URI chưa hợp lệ.');
if (String(parsed.JWT_ACCESS_SECRET || '').length < 32) errors.push('JWT_ACCESS_SECRET phải >= 32 ký tự.');

const cors = String(parsed.CORS_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
if (!cors.length) errors.push('CORS_ORIGINS đang trống.');
if (env === 'production' && cors.some((x) => x.startsWith('http://') || x === '*')) errors.push('Production CORS không được dùng HTTP hoặc * toàn cục.');

const redisRequired = String(parsed.REDIS_REQUIRED || 'false').toLowerCase() === 'true';
if (redisRequired && !parsed.REDIS_URL) errors.push('REDIS_REQUIRED=true nhưng REDIS_URL trống.');
const fcmRequired = String(parsed.FCM_REQUIRED || 'false').toLowerCase() === 'true';
const fcmEnabled = String(parsed.FCM_ENABLED || 'false').toLowerCase() === 'true';
if (fcmRequired && !fcmEnabled) errors.push('FCM_REQUIRED=true nhưng FCM_ENABLED không phải true.');

console.log('=== TH79 iMove VPS config check ===');
console.log(`ENV file       : ${envPath}`);
console.log(`NODE_ENV       : ${parsed.NODE_ENV || '(empty)'}`);
console.log(`HOST/PORT      : ${parsed.HOST || '(default)'}/${parsed.PORT || '(default)'}`);
console.log(`CORE_PUBLIC_URL: ${parsed.CORE_PUBLIC_URL || '(empty)'}`);
console.log(`MONGODB_DB     : ${parsed.MONGODB_DB || 'th79_imove'}`);
console.log(`MONGODB_URI    : ${parsed.MONGODB_URI ? '[SET]' : '[MISSING]'}`);
console.log(`JWT secret     : ${parsed.JWT_ACCESS_SECRET ? mask(parsed.JWT_ACCESS_SECRET) : '[MISSING]'}`);
console.log(`CORS_ORIGINS   : ${cors.join(', ') || '(empty)'}`);
console.log(`REDIS_REQUIRED : ${redisRequired}`);
console.log(`FCM_REQUIRED   : ${fcmRequired}`);

if (warnings.length) {
  console.log('\nWARNINGS:');
  for (const item of warnings) console.log(`- ${item}`);
}
if (errors.length) {
  console.log('\nERRORS:');
  for (const item of errors) console.log(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log('\nOK: Không phát hiện lỗi cấu hình bắt buộc.');
}
