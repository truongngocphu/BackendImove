const fs = require('fs');
const path = require('path');
const { paths } = require('../src/local_storage_service');

const days = Math.max(1, Number(process.env.FACE_EVIDENCE_RETENTION_DAYS || 30));
const cutoff = Date.now() - days * 86400 * 1000;
let removed = 0;

if (!fs.existsSync(paths.faceEvidence)) {
  console.log('No face-evidence directory.');
  process.exit(0);
}

for (const entry of fs.readdirSync(paths.faceEvidence, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(paths.faceEvidence, entry.name);
  const stat = fs.statSync(file);
  if (stat.mtimeMs < cutoff) {
    fs.unlinkSync(file);
    removed += 1;
    console.log('[REMOVED]', entry.name);
  }
}
console.log(`Done. Removed ${removed} expired local face evidence file(s).`);
