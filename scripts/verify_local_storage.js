const fs = require('fs');
const path = require('path');
const { paths, ensureLocalStorage } = require('../src/local_storage_service');

function testWrite(dir) {
  const file = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
  fs.writeFileSync(file, 'ok', { mode: 0o600 });
  fs.unlinkSync(file);
}

try {
  ensureLocalStorage();
  for (const [name, dir] of Object.entries(paths)) {
    if (name === 'root' || name.endsWith('Root') || ['kyc','fundReceipts','fundQr','faceEvidence','chat','merchant'].includes(name)) {
      testWrite(dir);
      console.log(`[OK] ${name}: ${dir}`);
    }
  }
  console.log('\nLOCAL STORAGE READY');
} catch (error) {
  console.error('LOCAL STORAGE FAILED:', error.message);
  process.exitCode = 1;
}
