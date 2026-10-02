const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');
const storageRoot = path.resolve(
  projectRoot,
  String(process.env.LOCAL_UPLOAD_ROOT || 'storage').trim() || 'storage',
);

const paths = Object.freeze({
  root: storageRoot,
  kyc: path.resolve(projectRoot, String(process.env.KYC_UPLOAD_DIR || path.join(storageRoot, 'kyc'))),
  fundReceipts: path.resolve(projectRoot, String(process.env.FUND_RECEIPT_UPLOAD_DIR || path.join(storageRoot, 'fund-receipts'))),
  fundQr: path.resolve(projectRoot, String(process.env.FUND_QR_UPLOAD_DIR || path.join(storageRoot, 'fund-qr'))),
  faceEvidence: path.resolve(projectRoot, String(process.env.FACE_EVIDENCE_UPLOAD_DIR || path.join(storageRoot, 'face-evidence'))),
  chat: path.resolve(projectRoot, String(process.env.CHAT_UPLOAD_DIR || path.join(storageRoot, 'chat'))),
  merchant: path.resolve(projectRoot, String(process.env.MERCHANT_UPLOAD_DIR || path.join(storageRoot, 'merchant'))),
});

function ensureLocalStorage() {
  if (String(process.env.FILE_STORAGE_PROVIDER || 'LOCAL').toUpperCase() !== 'LOCAL') {
    throw new Error('TH79 iMove 1.7.1 chỉ hỗ trợ FILE_STORAGE_PROVIDER=LOCAL trong patch này.');
  }
  Object.values(paths).forEach((dir) => {
    if (typeof dir === 'string') fs.mkdirSync(dir, { recursive: true });
  });
  return paths;
}

function assertInside(base, candidate) {
  const root = path.resolve(base);
  const resolved = path.resolve(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Đường dẫn file không hợp lệ.');
  }
  return resolved;
}

function resolveInside(base, ...parts) {
  return assertInside(base, path.join(base, ...parts.map((x) => String(x || ''))));
}

function relativeToProject(filePath) {
  return path.relative(projectRoot, path.resolve(filePath)).replace(/\\/g, '/');
}

function resolveProjectRelative(relativePath, allowedRoot = storageRoot) {
  const absolute = path.resolve(projectRoot, String(relativePath || ''));
  return assertInside(allowedRoot, absolute);
}

function extensionFor(file) {
  const byMime = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'application/pdf': '.pdf',
  };
  const mimeExt = byMime[String(file?.mimetype || '').toLowerCase()];
  if (mimeExt) return mimeExt;
  const ext = path.extname(String(file?.originalname || '')).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.pdf'].includes(ext) ? ext : '';
}

function randomStoredName(file, prefix = 'file') {
  const safePrefix = String(prefix || 'file').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'file';
  return `${safePrefix}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extensionFor(file)}`;
}

function removeFileQuiet(filePath, allowedRoot = storageRoot) {
  if (!filePath) return Promise.resolve(false);
  try {
    const absolute = assertInside(allowedRoot, filePath);
    return fs.promises.unlink(absolute).then(() => true).catch(() => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

ensureLocalStorage();

module.exports = {
  projectRoot,
  storageRoot,
  paths,
  ensureLocalStorage,
  assertInside,
  resolveInside,
  relativeToProject,
  resolveProjectRelative,
  extensionFor,
  randomStoredName,
  removeFileQuiet,
};
