const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
}

const auth = read('src/auth_routes.js');
const sms = read('src/otp_delivery_service.js');
const funds = read('src/fund_topup_routes.js');
const server = read('src/server.js');
const platform = read('src/platform_service.js');

check('Generic OTP request', auth.includes("router.post('/otp/request'"));
check('Generic OTP verify', auth.includes("router.post('/otp/verify'"));
check('Driver OTP request', auth.includes("'/driver/request-otp'"));
check('Driver register OTP validation', auth.includes('DRIVER_REGISTER'));
check('SpeedSMS adapter', sms.includes('SPEEDSMS_ACCESS_TOKEN') && sms.includes('SPEEDSMS_API_URL'));
check('Fund public router mounted', server.includes("app.use('/api/v171/funds'"));
check('Fund admin router mounted', server.includes("app.use('/api/v171/admin/funds'"));
check('Fund QR local storage', funds.includes('storage/fund-qr'));
check('Fund receipt local storage', funds.includes('storage/fund-receipts'));
check('Transfer content generation', funds.includes('transferContent'));
check('Message idempotency partial index',
  platform.includes("name: 'uq_message_idempotency'") &&
  platform.includes("idempotencyKey: { $exists: true, $type: 'string' }") &&
  !platform.includes("unique: true, sparse: true, name: 'uq_message_idempotency'")
);

let failed = 0;
for (const row of checks) {
  console.log(`${row.ok ? '[PASS]' : '[FAIL]'} ${row.name}${row.detail ? ` - ${row.detail}` : ''}`);
  if (!row.ok) failed += 1;
}
if (failed) {
  console.error(`\nSAFE PATCH VERIFY FAILED: ${failed} check(s).`);
  process.exit(1);
}
console.log('\nSAFE PATCH VERIFY PASS');
