const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { encryptText, last4, maskLast4 } = require('./kyc_crypto');
const { SERVICE_CODES } = require('./service_catalog_service');

const router = express.Router();
const DOC_TYPES = new Set(['CCCD', 'DRIVER_LICENSE', 'VEHICLE_REGISTRATION', 'CRIMINAL_RECORD']);
const VEHICLE_VIEWS = new Set(['front', 'left', 'right', 'rear']);
const DOC_SIDES = {
  CCCD: new Set(['front', 'back']),
  DRIVER_LICENSE: new Set(['front', 'back']),
  VEHICLE_REGISTRATION: new Set(['front', 'back']),
  CRIMINAL_RECORD: new Set(['document']),
};


const VEHICLE_SERVICE_RULES = Object.freeze({
  MOTORBIKE: ['BIKE', 'FOOD', 'ERRAND', 'DELIVERY'],
  CAR_4: ['CAR_4'],
  CAR_7: ['CAR_7'],
  MPV_7: ['MPV_7'],
  LUXURY_4: ['LUXURY_4'],
  LUXURY_7: ['LUXURY_7'],
});

function normalizeVehicleType(value) {
  const code = String(value || 'MOTORBIKE').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(VEHICLE_SERVICE_RULES, code) ? code : 'MOTORBIKE';
}

function normalizeVehicleServices(vehicleType, raw, fallback = []) {
  const allowed = VEHICLE_SERVICE_RULES[vehicleType] || VEHICLE_SERVICE_RULES.MOTORBIKE;
  const source = Array.isArray(raw) && raw.length ? raw : fallback;
  const selected = [...new Set((Array.isArray(source) ? source : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter((code) => SERVICE_CODES.includes(code) && allowed.includes(code)))];
  if (selected.length) return selected;
  return vehicleType === 'MOTORBIKE' ? ['BIKE'] : [allowed[0]];
}

function normalizeServicePreferences(codes, raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(codes.map((code) => [code, source[code] !== false]));
}

const now = () => new Date();
const projectRoot = path.resolve(__dirname, '..');
const uploadRoot = path.resolve(projectRoot, String(process.env.KYC_UPLOAD_DIR || 'storage/kyc'));
const maxFileMb = Math.max(1, Math.min(20, Number(process.env.KYC_MAX_FILE_MB || 8)));
fs.mkdirSync(uploadRoot, { recursive: true });

function safeObjectId(value) {
  try { return new ObjectId(value); } catch (_) { return null; }
}

function jwtSecret() {
  const secret = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (secret.length < 32) throw new Error('JWT_ACCESS_SECRET chưa được cấu hình an toàn.');
  return secret;
}

function createAuthGuard(getDb) {
  return async (req, res, next) => {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Thiếu Access Token.' });
      }
      const token = header.slice(7).trim();
      const payload = jwt.verify(token, jwtSecret());
      const userId = safeObjectId(payload.sub || payload.userId);
      if (!userId) return res.status(401).json({ message: 'Access Token không hợp lệ.' });
      const db = getDb();
      if (!db) return res.status(503).json({ message: 'Database chưa sẵn sàng.' });
      const user = await db.collection('users').findOne({ _id: userId, status: { $ne: 'DISABLED' } });
      if (!user) return res.status(401).json({ message: 'Tài khoản không tồn tại hoặc đã bị khóa.' });
      req.auth = {
        userId: user._id,
        user,
        roles: Array.isArray(user.roles) ? user.roles : [],
      };
      return next();
    } catch (error) {
      return res.status(401).json({ message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.auth?.roles?.includes(role)) {
      return res.status(403).json({ message: `Yêu cầu quyền ${role}.` });
    }
    return next();
  };
}

function multerStorage() {
  return multer.diskStorage({
    destination: (req, _file, cb) => {
      const owner = String(req.auth?.userId || 'unknown');
      const dir = path.join(uploadRoot, owner);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext) ? ext : '';
      cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${safeExt}`);
    },
  });
}

const upload = multer({
  storage: multerStorage(),
  limits: { fileSize: maxFileMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
    if (!ok) return cb(new Error('Chỉ chấp nhận JPG, PNG, WEBP hoặc PDF.'));
    cb(null, true);
  },
});

async function getDriver(db, userId) {
  return db.collection('drivers').findOne({ userId });
}

async function ensureDriver(db, userId) {
  let driver = await getDriver(db, userId);
  if (driver) return driver;
  const createdAt = now();
  const doc = {
    userId,
    approvalStatus: 'PENDING',
    kycStatus: 'INCOMPLETE',
    onlineStatus: 'OFFLINE',
    rating: 5,
    completedTrips: 0,
    cancelledTrips: 0,
    acceptanceRate: 100,
    documentsStatus: {
      cccd: 'MISSING',
      driverLicense: 'MISSING',
      vehicleRegistration: 'MISSING',
      criminalRecord: 'MISSING',
      vehiclePhotos: 'MISSING',
      bankAccount: 'MISSING',
      avatar: 'MISSING',
    },
    createdAt,
    updatedAt: createdAt,
  };
  const result = await db.collection('drivers').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

function publicUser(user) {
  return {
    id: String(user._id),
    phone: user.phone || null,
    fullName: user.fullName || null,
    email: user.email || null,
    roles: user.roles || [],
    status: user.status || 'ACTIVE',
    avatar: user.avatar || (user.avatarUrl ? { legacyUrl: user.avatarUrl } : null),
  };
}

function publicDocument(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    type: doc.type,
    fullName: doc.fullName || null,
    dateOfBirth: doc.dateOfBirth || null,
    issueDate: doc.issueDate || null,
    expiryDate: doc.expiryDate || null,
    issuedBy: doc.issuedBy || null,
    licenseClass: doc.licenseClass || null,
    plateNumber: doc.plateNumber || null,
    ownerName: doc.ownerName || null,
    documentNumberMasked: maskLast4(doc.documentNumberLast4),
    licenseNumberMasked: maskLast4(doc.licenseNumberLast4),
    registrationNumberMasked: maskLast4(doc.registrationNumberLast4),
    files: doc.files || {},
    status: doc.status || 'MISSING',
    rejectionReason: doc.rejectionReason || null,
    verifiedAt: doc.verifiedAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function publicBank(bank) {
  if (!bank) return null;
  return {
    id: String(bank._id),
    bankCode: bank.bankCode || null,
    bankName: bank.bankName || null,
    accountName: bank.accountName || null,
    accountNumberMasked: maskLast4(bank.accountNumberLast4),
    isDefault: Boolean(bank.isDefault),
    verificationStatus: bank.verificationStatus || 'MISSING',
    rejectionReason: bank.rejectionReason || null,
    updatedAt: bank.updatedAt || null,
  };
}

function publicVehicle(vehicle) {
  if (!vehicle) return null;
  return {
    id: String(vehicle._id),
    vehicleType: vehicle.vehicleType || 'MOTORBIKE',
    serviceCode: vehicle.serviceCode || 'BIKE',
    serviceCodes: Array.isArray(vehicle.serviceCodes) && vehicle.serviceCodes.length ? vehicle.serviceCodes : [vehicle.serviceCode || 'BIKE'],
    requestedServiceCodes: Array.isArray(vehicle.requestedServiceCodes) && vehicle.requestedServiceCodes.length
      ? vehicle.requestedServiceCodes
      : (Array.isArray(vehicle.serviceCodes) && vehicle.serviceCodes.length ? vehicle.serviceCodes : [vehicle.serviceCode || 'BIKE']),
    approvedServiceCodes: Array.isArray(vehicle.approvedServiceCodes) ? vehicle.approvedServiceCodes : [],
    servicePreferences: vehicle.servicePreferences && typeof vehicle.servicePreferences === 'object' ? vehicle.servicePreferences : {},
    plateNumber: vehicle.plateNumber || null,
    brand: vehicle.brand || null,
    model: vehicle.model || null,
    color: vehicle.color || null,
    year: vehicle.year || null,
    status: vehicle.status || 'PENDING',
    verificationStatus: vehicle.verificationStatus || vehicle.status || 'PENDING',
    photos: vehicle.photos || { front: null, left: null, right: null, rear: null },
    rejectionReason: vehicle.rejectionReason || null,
    updatedAt: vehicle.updatedAt || null,
  };
}

function docStatusKey(type) {
  return ({
    CCCD: 'cccd',
    DRIVER_LICENSE: 'driverLicense',
    VEHICLE_REGISTRATION: 'vehicleRegistration',
    CRIMINAL_RECORD: 'criminalRecord',
  })[type];
}

async function saveFileRecord(db, req, file, category, slot, driverId = null) {
  const relativePath = path.relative(projectRoot, file.path).replace(/\\/g, '/');
  const doc = {
    ownerUserId: req.auth.userId,
    driverId: driverId || null,
    category,
    slot,
    storage: 'PRIVATE_LOCAL',
    relativePath,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    status: 'ACTIVE',
    createdAt: now(),
  };
  const result = await db.collection('kyc_files').insertOne(doc);
  return {
    id: String(result.insertedId),
    mimeType: doc.mimeType,
    size: doc.size,
    originalName: doc.originalName,
  };
}

function missingRequirements({ user, documents, vehicle, bank }) {
  const byType = new Map(documents.map((d) => [d.type, d]));
  const missing = [];
  const avatar = user.avatar;
  if (!avatar?.fileId && !avatar?.url && !user.avatarUrl) missing.push('Ảnh đại diện');
  const checks = [
    ['CCCD', ['front', 'back'], 'CCCD mặt trước + mặt sau'],
    ['DRIVER_LICENSE', ['front', 'back'], 'Bằng lái xe mặt trước + mặt sau'],
    ['VEHICLE_REGISTRATION', ['front', 'back'], 'Cà vẹt xe mặt trước + mặt sau'],
    ['CRIMINAL_RECORD', ['document'], 'Lý lịch tư pháp'],
  ];
  for (const [type, slots, label] of checks) {
    const doc = byType.get(type);
    if (!doc || slots.some((slot) => !doc.files?.[slot]?.id)) missing.push(label);
  }
  if (!vehicle) {
    missing.push('Thông tin xe');
  } else {
    for (const view of VEHICLE_VIEWS) {
      if (!vehicle.photos?.[view]?.id) missing.push(`Ảnh xe: ${view}`);
    }
  }
  if (!bank?.accountNumberEncrypted || !bank?.bankName || !bank?.accountName) missing.push('Tài khoản ngân hàng');
  return missing;
}

function createKycRouter({ getDb }) {
  const authGuard = createAuthGuard(getDb);
  router.use(authGuard);

  router.get('/me/profile', async (req, res) => {
    return res.json(publicUser(req.auth.user));
  });

  router.patch('/me/profile', async (req, res) => {
    try {
      const db = getDb();
      const patch = { updatedAt: now() };
      if (req.body?.fullName !== undefined) patch.fullName = String(req.body.fullName || '').trim();
      if (req.body?.email !== undefined) patch.email = String(req.body.email || '').trim() || null;
      await db.collection('users').updateOne({ _id: req.auth.userId }, { $set: patch });
      const user = await db.collection('users').findOne({ _id: req.auth.userId });
      return res.json(publicUser(user));
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.post('/me/avatar', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: 'Chưa chọn ảnh đại diện.' });
      if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ message: 'Ảnh đại diện phải là file ảnh.' });
      const db = getDb();
      const driver = req.auth.roles.includes('DRIVER') ? await ensureDriver(db, req.auth.userId) : null;
      const file = await saveFileRecord(db, req, req.file, 'AVATAR', 'avatar', driver?._id || null);
      const avatar = { fileId: file.id, mimeType: file.mimeType, size: file.size, updatedAt: now() };
      await db.collection('users').updateOne({ _id: req.auth.userId }, { $set: { avatar, updatedAt: now() } });
      if (driver) {
        await db.collection('drivers').updateOne({ _id: driver._id }, { $set: { 'documentsStatus.avatar': 'UPLOADED', updatedAt: now() } });
      }
      return res.status(201).json({ ok: true, avatar });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.get('/driver/profile', requireRole('DRIVER'), async (req, res) => {
    try {
      const db = getDb();
      const driver = await ensureDriver(db, req.auth.userId);
      const [documents, vehicle, bank] = await Promise.all([
        db.collection('driver_documents').find({ driverId: driver._id }).toArray(),
        db.collection('vehicles').findOne({ driverId: driver._id }, { sort: { updatedAt: -1 } }),
        db.collection('driver_bank_accounts').findOne({ driverId: driver._id, isDefault: true }),
      ]);
      return res.json({
        user: publicUser(req.auth.user),
        driver,
        documents: documents.map(publicDocument),
        vehicle: publicVehicle(vehicle),
        bankAccount: publicBank(bank),
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.put('/driver/documents/:type', requireRole('DRIVER'), async (req, res) => {
    try {
      const type = String(req.params.type || '').toUpperCase();
      if (!DOC_TYPES.has(type)) return res.status(400).json({ message: 'Loại giấy tờ không hợp lệ.' });
      const db = getDb();
      const driver = await ensureDriver(db, req.auth.userId);
      const body = req.body || {};
      const existing = await db.collection('driver_documents').findOne({ driverId: driver._id, type });
      const patch = {
        fullName: body.fullName !== undefined ? String(body.fullName || '').trim() || null : existing?.fullName || null,
        dateOfBirth: body.dateOfBirth !== undefined ? body.dateOfBirth || null : existing?.dateOfBirth || null,
        issueDate: body.issueDate !== undefined ? body.issueDate || null : existing?.issueDate || null,
        expiryDate: body.expiryDate !== undefined ? body.expiryDate || null : existing?.expiryDate || null,
        issuedBy: body.issuedBy !== undefined ? String(body.issuedBy || '').trim() || null : existing?.issuedBy || null,
        licenseClass: body.licenseClass !== undefined ? String(body.licenseClass || '').trim() || null : existing?.licenseClass || null,
        plateNumber: body.plateNumber !== undefined ? String(body.plateNumber || '').trim() || null : existing?.plateNumber || null,
        ownerName: body.ownerName !== undefined ? String(body.ownerName || '').trim() || null : existing?.ownerName || null,
        files: existing?.files || {},
        status: 'UPLOADED',
        rejectionReason: null,
        updatedAt: now(),
      };
      const number = String(body.documentNumber || body.licenseNumber || body.registrationNumber || '').trim();
      if (number) {
        if (type === 'DRIVER_LICENSE') {
          patch.licenseNumberEncrypted = encryptText(number);
          patch.licenseNumberLast4 = last4(number);
        } else if (type === 'VEHICLE_REGISTRATION') {
          patch.registrationNumberEncrypted = encryptText(number);
          patch.registrationNumberLast4 = last4(number);
        } else {
          patch.documentNumberEncrypted = encryptText(number);
          patch.documentNumberLast4 = last4(number);
        }
      }
      await db.collection('driver_documents').updateOne(
        { driverId: driver._id, type },
        { $set: patch, $setOnInsert: { driverId: driver._id, userId: req.auth.userId, type, createdAt: now() } },
        { upsert: true },
      );
      const key = docStatusKey(type);
      await db.collection('drivers').updateOne({ _id: driver._id }, { $set: { [`documentsStatus.${key}`]: 'UPLOADED', kycStatus: 'INCOMPLETE', updatedAt: now() } });
      const doc = await db.collection('driver_documents').findOne({ driverId: driver._id, type });
      return res.json(publicDocument(doc));
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.post('/driver/documents/:type/:side', requireRole('DRIVER'), upload.single('file'), async (req, res) => {
    try {
      const type = String(req.params.type || '').toUpperCase();
      const side = String(req.params.side || '').toLowerCase();
      if (!DOC_TYPES.has(type) || !DOC_SIDES[type]?.has(side)) return res.status(400).json({ message: 'Loại giấy tờ hoặc mặt giấy tờ không hợp lệ.' });
      if (!req.file) return res.status(400).json({ message: 'Chưa chọn file.' });
      const db = getDb();
      const driver = await ensureDriver(db, req.auth.userId);
      const file = await saveFileRecord(db, req, req.file, type, side, driver._id);
      await db.collection('driver_documents').updateOne(
        { driverId: driver._id, type },
        {
          $set: { [`files.${side}`]: file, status: 'UPLOADED', rejectionReason: null, updatedAt: now() },
          $setOnInsert: { driverId: driver._id, userId: req.auth.userId, type, createdAt: now() },
        },
        { upsert: true },
      );
      const key = docStatusKey(type);
      await db.collection('drivers').updateOne({ _id: driver._id }, { $set: { [`documentsStatus.${key}`]: 'UPLOADED', kycStatus: 'INCOMPLETE', updatedAt: now() } });
      return res.status(201).json({ ok: true, type, side, file });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.put('/driver/vehicle', requireRole('DRIVER'), async (req, res) => {
    try {
      const db = getDb();
      const driver = await ensureDriver(db, req.auth.userId);
      const body = req.body || {};
      const existing = await db.collection('vehicles').findOne({ driverId: driver._id }, { sort: { updatedAt: -1 } });
      const vehicleType = normalizeVehicleType(
        body.vehicleType || existing?.vehicleType || driver.vehicleType || driver.requestedVehicleType || 'MOTORBIKE',
      );
      const rawRequested = Array.isArray(body.requestedServiceCodes)
        ? body.requestedServiceCodes
        : (Array.isArray(body.serviceCodes) ? body.serviceCodes : []);
      const fallbackCodes = Array.isArray(existing?.requestedServiceCodes) && existing.requestedServiceCodes.length
        ? existing.requestedServiceCodes
        : (Array.isArray(existing?.serviceCodes) ? existing.serviceCodes : [existing?.serviceCode || 'BIKE']);
      const requestedServiceCodes = normalizeVehicleServices(vehicleType, rawRequested, fallbackCodes);
      const servicePreferences = normalizeServicePreferences(
        requestedServiceCodes,
        body.servicePreferences || existing?.servicePreferences || driver.servicePreferences || {},
      );
      const vehicleChanged = Boolean(existing) && (
        String(existing.vehicleType || 'MOTORBIKE') !== vehicleType
        || String(existing.plateNumber || '').trim() !== String(body.plateNumber || existing?.plateNumber || '').trim()
      );
      const patch = {
        vehicleType,
        serviceCode: requestedServiceCodes[0],
        serviceCodes: requestedServiceCodes,
        requestedServiceCodes,
        approvedServiceCodes: vehicleChanged ? [] : (Array.isArray(existing?.approvedServiceCodes) ? existing.approvedServiceCodes : []),
        servicePreferences,
        plateNumber: String(body.plateNumber || existing?.plateNumber || '').trim(),
        brand: String(body.brand || existing?.brand || '').trim() || null,
        model: String(body.model || existing?.model || '').trim() || null,
        color: String(body.color || existing?.color || '').trim() || null,
        year: body.year !== undefined ? Number(body.year) || null : existing?.year || null,
        photos: existing?.photos || { front: null, left: null, right: null, rear: null },
        verificationStatus: vehicleChanged ? 'UPLOADED' : (existing?.verificationStatus === 'APPROVED' ? 'APPROVED' : 'UPLOADED'),
        rejectionReason: null,
        updatedAt: now(),
      };
      if (!patch.plateNumber) return res.status(400).json({ message: 'Biển số xe là bắt buộc.' });
      if (existing) {
        await db.collection('vehicles').updateOne({ _id: existing._id }, { $set: patch });
      } else {
        await db.collection('vehicles').insertOne({ driverId: driver._id, status: 'PENDING', ...patch, createdAt: now() });
      }
      await db.collection('drivers').updateOne(
        { _id: driver._id },
        {
          $set: {
            requestedVehicleType: vehicleType,
            vehicleType,
            requestedServiceCodes,
            servicePreferences,
            updatedAt: now(),
          },
        },
      );
      const vehicle = await db.collection('vehicles').findOne({ driverId: driver._id }, { sort: { updatedAt: -1 } });
      return res.json(publicVehicle(vehicle));
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.post('/driver/vehicle/photos/:view', requireRole('DRIVER'), upload.single('file'), async (req, res) => {
    try {
      const view = String(req.params.view || '').toLowerCase();
      if (!VEHICLE_VIEWS.has(view)) return res.status(400).json({ message: 'Góc chụp xe không hợp lệ.' });
      if (!req.file || !req.file.mimetype.startsWith('image/')) return res.status(400).json({ message: 'Ảnh xe phải là file ảnh.' });
      const db = getDb();
      const driver = await ensureDriver(db, req.auth.userId);
      let vehicle = await db.collection('vehicles').findOne({ driverId: driver._id }, { sort: { updatedAt: -1 } });
      if (!vehicle) {
        const result = await db.collection('vehicles').insertOne({
          driverId: driver._id,
          serviceCode: 'BIKE',
          plateNumber: null,
          brand: null,
          model: null,
          color: null,
          year: null,
          status: 'PENDING',
          verificationStatus: 'UPLOADED',
          photos: { front: null, left: null, right: null, rear: null },
          createdAt: now(),
          updatedAt: now(),
        });
        vehicle = await db.collection('vehicles').findOne({ _id: result.insertedId });
      }
      const file = await saveFileRecord(db, req, req.file, 'VEHICLE_PHOTO', view, driver._id);
      await db.collection('vehicles').updateOne({ _id: vehicle._id }, { $set: { [`photos.${view}`]: file, verificationStatus: 'UPLOADED', rejectionReason: null, updatedAt: now() } });
      const updated = await db.collection('vehicles').findOne({ _id: vehicle._id });
      const allPhotos = [...VEHICLE_VIEWS].every((v) => updated.photos?.[v]?.id);
      await db.collection('drivers').updateOne({ _id: driver._id }, { $set: { 'documentsStatus.vehiclePhotos': allPhotos ? 'UPLOADED' : 'MISSING', kycStatus: 'INCOMPLETE', updatedAt: now() } });
      return res.status(201).json({ ok: true, view, file });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.put('/driver/bank-account', requireRole('DRIVER'), async (req, res) => {
    try {
      const db = getDb();
      const driver = await ensureDriver(db, req.auth.userId);
      const body = req.body || {};
      const bankCode = String(body.bankCode || '').trim().toUpperCase();
      const bankName = String(body.bankName || '').trim();
      const accountName = String(body.accountName || '').trim().toUpperCase();
      const accountNumber = String(body.accountNumber || '').replace(/\s+/g, '');
      if (!bankName || !accountName || !accountNumber) return res.status(400).json({ message: 'Thiếu ngân hàng, tên chủ tài khoản hoặc số tài khoản.' });
      const patch = {
        bankCode: bankCode || null,
        bankName,
        accountName,
        accountNumberEncrypted: encryptText(accountNumber),
        accountNumberLast4: last4(accountNumber),
        isDefault: true,
        verificationStatus: 'UPLOADED',
        rejectionReason: null,
        updatedAt: now(),
      };
      await db.collection('driver_bank_accounts').updateOne(
        { driverId: driver._id, isDefault: true },
        { $set: patch, $setOnInsert: { driverId: driver._id, userId: req.auth.userId, createdAt: now() } },
        { upsert: true },
      );
      await db.collection('drivers').updateOne({ _id: driver._id }, { $set: { 'documentsStatus.bankAccount': 'UPLOADED', kycStatus: 'INCOMPLETE', updatedAt: now() } });
      const bank = await db.collection('driver_bank_accounts').findOne({ driverId: driver._id, isDefault: true });
      return res.json(publicBank(bank));
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.post('/driver/submit', requireRole('DRIVER'), async (req, res) => {
    try {
      const db = getDb();
      const driver = await ensureDriver(db, req.auth.userId);
      if (driver.kycStatus === 'APPROVED') return res.json({ ok: true, kycStatus: 'APPROVED', message: 'Hồ sơ đã được duyệt.' });
      const [documents, vehicle, bank, user] = await Promise.all([
        db.collection('driver_documents').find({ driverId: driver._id }).toArray(),
        db.collection('vehicles').findOne({ driverId: driver._id }, { sort: { updatedAt: -1 } }),
        db.collection('driver_bank_accounts').findOne({ driverId: driver._id, isDefault: true }),
        db.collection('users').findOne({ _id: req.auth.userId }),
      ]);
      const missing = missingRequirements({ user, documents, vehicle, bank });
      if (missing.length) return res.status(400).json({ message: 'Hồ sơ chưa đầy đủ.', missing });
      const changedAt = now();
      await db.collection('drivers').updateOne({ _id: driver._id }, { $set: { kycStatus: 'SUBMITTED', approvalStatus: 'PENDING', kycSubmittedAt: changedAt, updatedAt: changedAt } });
      await db.collection('driver_documents').updateMany({ driverId: driver._id }, { $set: { status: 'UNDER_REVIEW', updatedAt: changedAt } });
      await db.collection('vehicles').updateMany({ driverId: driver._id }, { $set: { verificationStatus: 'UNDER_REVIEW', updatedAt: changedAt } });
      await db.collection('driver_bank_accounts').updateMany({ driverId: driver._id }, { $set: { verificationStatus: 'UNDER_REVIEW', updatedAt: changedAt } });
      return res.json({ ok: true, kycStatus: 'SUBMITTED', message: 'Đã gửi hồ sơ để xét duyệt.' });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.get('/driver/status', requireRole('DRIVER'), async (req, res) => {
    const db = getDb();
    const driver = await ensureDriver(db, req.auth.userId);
    return res.json({
      driverId: String(driver._id),
      approvalStatus: driver.approvalStatus || 'PENDING',
      kycStatus: driver.kycStatus || 'INCOMPLETE',
      onlineStatus: driver.onlineStatus || 'OFFLINE',
      documentsStatus: driver.documentsStatus || {},
      rejectionReason: driver.kycRejectionReason || null,
    });
  });

  router.get('/files/:fileId', async (req, res) => {
    try {
      const id = safeObjectId(req.params.fileId);
      if (!id) return res.status(400).json({ message: 'File id không hợp lệ.' });
      const db = getDb();
      const file = await db.collection('kyc_files').findOne({ _id: id, status: 'ACTIVE' });
      if (!file) return res.status(404).json({ message: 'Không tìm thấy file.' });
      const isAdmin = req.auth.roles.includes('ADMIN');
      if (!isAdmin && String(file.ownerUserId) !== String(req.auth.userId)) return res.status(403).json({ message: 'Không có quyền xem file này.' });
      const absolute = path.resolve(projectRoot, file.relativePath);
      if (!absolute.startsWith(uploadRoot) || !fs.existsSync(absolute)) return res.status(404).json({ message: 'File vật lý không tồn tại.' });
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.sendFile(absolute);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/admin/drivers', requireRole('ADMIN'), async (req, res) => {
    try {
      const db = getDb();
      const status = String(req.query.status || '').toUpperCase();
      const query = status ? { $or: [{ kycStatus: status }, { approvalStatus: status }] } : {};
      const drivers = await db.collection('drivers').find(query).sort({ updatedAt: -1 }).limit(200).toArray();
      const userIds = drivers.map((d) => d.userId).filter(Boolean);
      const users = await db.collection('users').find({ _id: { $in: userIds } }).toArray();
      const userMap = new Map(users.map((u) => [String(u._id), u]));
      return res.json(drivers.map((d) => ({
        driverId: String(d._id),
        user: publicUser(userMap.get(String(d.userId)) || { _id: d.userId }),
        approvalStatus: d.approvalStatus,
        kycStatus: d.kycStatus,
        onlineStatus: d.onlineStatus,
        documentsStatus: d.documentsStatus || {},
        updatedAt: d.updatedAt || null,
      })));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/admin/drivers/:driverId', requireRole('ADMIN'), async (req, res) => {
    try {
      const driverId = safeObjectId(req.params.driverId);
      if (!driverId) return res.status(400).json({ message: 'Driver id không hợp lệ.' });
      const db = getDb();
      const driver = await db.collection('drivers').findOne({ _id: driverId });
      if (!driver) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const [user, documents, vehicle, bank, logs] = await Promise.all([
        db.collection('users').findOne({ _id: driver.userId }),
        db.collection('driver_documents').find({ driverId }).toArray(),
        db.collection('vehicles').findOne({ driverId }, { sort: { updatedAt: -1 } }),
        db.collection('driver_bank_accounts').findOne({ driverId, isDefault: true }),
        db.collection('verification_logs').find({ driverId }).sort({ createdAt: -1 }).limit(100).toArray(),
      ]);
      return res.json({
        driver,
        user: publicUser(user),
        documents: documents.map(publicDocument),
        vehicle: publicVehicle(vehicle),
        bankAccount: publicBank(bank),
        verificationLogs: logs,
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/admin/drivers/:driverId/review', requireRole('ADMIN'), async (req, res) => {
    try {
      const driverId = safeObjectId(req.params.driverId);
      if (!driverId) return res.status(400).json({ message: 'Driver id không hợp lệ.' });
      const decision = String(req.body?.decision || '').toUpperCase();
      if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ message: 'decision phải là APPROVE hoặc REJECT.' });
      const reason = String(req.body?.reason || '').trim() || null;
      if (decision === 'REJECT' && !reason) return res.status(400).json({ message: 'Từ chối hồ sơ phải có lý do.' });
      const db = getDb();
      const driver = await db.collection('drivers').findOne({ _id: driverId });
      if (!driver) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const changedAt = now();
      // ADMIN_APPROVE_COMPLETENESS_GUARD_V5_3
      if (decision === 'APPROVE') {
        if (!['SUBMITTED', 'UNDER_REVIEW'].includes(String(driver.kycStatus || '').toUpperCase())) {
          return res.status(409).json({
            message: 'Tài xế chưa gửi hồ sơ xét duyệt.',
            kycStatus: driver.kycStatus || 'INCOMPLETE',
          });
        }

        const [reviewUser, reviewDocuments, reviewVehicle, reviewBank] = await Promise.all([
          db.collection('users').findOne({ _id: driver.userId }),
          db.collection('driver_documents').find({ driverId }).toArray(),
          db.collection('vehicles').findOne({ driverId }, { sort: { updatedAt: -1 } }),
          db.collection('driver_bank_accounts').findOne({ driverId, isDefault: true }),
        ]);

        const missing = missingRequirements({
          user: reviewUser || {},
          documents: reviewDocuments,
          vehicle: reviewVehicle,
          bank: reviewBank,
        });

        if (missing.length) {
          return res.status(409).json({
            message: 'Không thể duyệt vì hồ sơ chưa đầy đủ.',
            missing,
          });
        }
      }

      if (decision === 'APPROVE') {
        await db.collection('drivers').updateOne({ _id: driverId }, { $set: {
          approvalStatus: 'APPROVED',
          kycStatus: 'APPROVED',
          kycReviewedAt: changedAt,
          kycReviewedBy: req.auth.userId,
          kycRejectionReason: null,
          documentsStatus: {
            cccd: 'APPROVED', driverLicense: 'APPROVED', vehicleRegistration: 'APPROVED', criminalRecord: 'APPROVED', vehiclePhotos: 'APPROVED', bankAccount: 'APPROVED', avatar: 'APPROVED',
          },
          updatedAt: changedAt,
        } });
        await db.collection('driver_documents').updateMany({ driverId }, { $set: { status: 'APPROVED', rejectionReason: null, verifiedBy: req.auth.userId, verifiedAt: changedAt, updatedAt: changedAt } });
        const approvedVehicle = await db.collection('vehicles').findOne({ driverId }, { sort: { updatedAt: -1 } });
        const approvedVehicleType = normalizeVehicleType(approvedVehicle?.vehicleType || driver.vehicleType || driver.requestedVehicleType || 'MOTORBIKE');
        const approvedServiceCodes = normalizeVehicleServices(
          approvedVehicleType,
          approvedVehicle?.requestedServiceCodes || approvedVehicle?.serviceCodes,
          ['BIKE'],
        );
        const approvedPreferences = normalizeServicePreferences(
          approvedServiceCodes,
          approvedVehicle?.servicePreferences || driver.servicePreferences || {},
        );
        await db.collection('vehicles').updateMany({ driverId }, { $set: {
          status: 'APPROVED',
          verificationStatus: 'APPROVED',
          vehicleType: approvedVehicleType,
          approvedServiceCodes,
          servicePreferences: approvedPreferences,
          rejectionReason: null,
          verifiedAt: changedAt,
          updatedAt: changedAt,
        } });
        await db.collection('drivers').updateOne({ _id: driverId }, { $set: {
          vehicleType: approvedVehicleType,
          requestedVehicleType: approvedVehicleType,
          requestedServiceCodes: approvedServiceCodes,
          approvedServiceCodes,
          servicePreferences: approvedPreferences,
          updatedAt: changedAt,
        } });
        await db.collection('driver_bank_accounts').updateMany({ driverId }, { $set: { verificationStatus: 'APPROVED', rejectionReason: null, verifiedAt: changedAt, updatedAt: changedAt } });
      } else {
        await db.collection('drivers').updateOne({ _id: driverId }, { $set: { approvalStatus: 'PENDING', kycStatus: 'REJECTED', kycRejectionReason: reason, kycReviewedAt: changedAt, kycReviewedBy: req.auth.userId, onlineStatus: 'OFFLINE', updatedAt: changedAt } });
        await db.collection('driver_documents').updateMany({ driverId }, { $set: { status: 'REJECTED', rejectionReason: reason, verifiedBy: req.auth.userId, verifiedAt: changedAt, updatedAt: changedAt } });
        await db.collection('vehicles').updateMany({ driverId }, { $set: { verificationStatus: 'REJECTED', rejectionReason: reason, updatedAt: changedAt } });
        await db.collection('driver_bank_accounts').updateMany({ driverId }, { $set: { verificationStatus: 'REJECTED', rejectionReason: reason, updatedAt: changedAt } });
      }
      await db.collection('verification_logs').insertOne({
        driverId,
        action: decision === 'APPROVE' ? 'DRIVER_KYC_APPROVED' : 'DRIVER_KYC_REJECTED',
        actorUserId: req.auth.userId,
        reason,
        createdAt: changedAt,
      });
      return res.json({ ok: true, decision, kycStatus: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });


  router.post('/admin/drivers/:driverId/services', requireRole('ADMIN'), async (req, res) => {
    try {
      const driverId = safeObjectId(req.params.driverId);
      if (!driverId) return res.status(400).json({ message: 'Driver id không hợp lệ.' });
      const db = getDb();
      const driver = await db.collection('drivers').findOne({ _id: driverId });
      if (!driver) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const vehicle = await db.collection('vehicles').findOne({ driverId }, { sort: { updatedAt: -1 } });
      if (!vehicle) return res.status(404).json({ message: 'Tài xế chưa có phương tiện.' });
      const vehicleType = normalizeVehicleType(vehicle.vehicleType || driver.vehicleType || 'MOTORBIKE');
      const approvedServiceCodes = normalizeVehicleServices(vehicleType, req.body?.approvedServiceCodes, []);
      const servicePreferences = normalizeServicePreferences(
        approvedServiceCodes,
        req.body?.servicePreferences || vehicle.servicePreferences || driver.servicePreferences || {},
      );
      const changedAt = now();
      await Promise.all([
        db.collection('vehicles').updateOne({ _id: vehicle._id }, { $set: { approvedServiceCodes, servicePreferences, updatedAt: changedAt } }),
        db.collection('drivers').updateOne({ _id: driverId }, { $set: { approvedServiceCodes, servicePreferences, updatedAt: changedAt } }),
        db.collection('verification_logs').insertOne({
          driverId,
          action: 'DRIVER_SERVICES_UPDATED',
          actorUserId: req.auth.userId,
          approvedServiceCodes,
          servicePreferences,
          createdAt: changedAt,
        }),
      ]);
      return res.json({ ok: true, vehicleType, approvedServiceCodes, servicePreferences });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  return router;
}

module.exports = { createKycRouter };