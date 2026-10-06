function bool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return String(raw).trim().toLowerCase() === 'true';
}

function csv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function assertProductionConfig() {
  const production = String(process.env.NODE_ENV || 'development').trim().toLowerCase() === 'production';
  if (!production) return { production: false };

  const errors = [];

  if (bool('AUTH_DEV_SHOW_OTP', false)) errors.push('AUTH_DEV_SHOW_OTP phải là false');
  if (bool('V64_DEMO_TOPUP_ENABLED', false)) errors.push('V64_DEMO_TOPUP_ENABLED phải là false');
  if (bool('LAN_DISCOVERY_ENABLED', false)) errors.push('LAN_DISCOVERY_ENABLED phải là false');
  if (bool('MATCHING_ALLOW_NO_GPS_FALLBACK', false)) errors.push('MATCHING_ALLOW_NO_GPS_FALLBACK phải là false');
  if (bool('SEED_DEMO_ON_START', false)) errors.push('SEED_DEMO_ON_START phải là false');
  if (!bool('TRUST_MATCHING_ENFORCEMENT', true)) errors.push('TRUST_MATCHING_ENFORCEMENT phải là true');

  const faceMode = String(process.env.FACE_PROVIDER_MODE || 'MANUAL').trim().toUpperCase();
  if (faceMode === 'DEV') errors.push('FACE_PROVIDER_MODE production không được là DEV');

  const faceKey = String(process.env.FACE_EVIDENCE_KEY || process.env.KYC_DATA_KEY || '').trim();
  if (faceKey.length < 32) errors.push('FACE_EVIDENCE_KEY hoặc KYC_DATA_KEY phải >= 32 ký tự');

  const accessSecret = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (accessSecret.length < 32 || /CHANGE_TO|changeme|secret/i.test(accessSecret)) {
    errors.push('JWT_ACCESS_SECRET phải là secret production >= 32 ký tự');
  }

  const mongoUri = String(process.env.MONGODB_URI || '').trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(mongoUri) || /USERNAME|PASSWORD|YOUR_/i.test(mongoUri)) {
    errors.push('MONGODB_URI production chưa hợp lệ');
  }

  // Redis là tùy chọn. Chỉ bắt buộc REDIS_URL khi REDIS_REQUIRED=true.
  const redisRequired = bool('REDIS_REQUIRED', false);
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  if (redisRequired && !redisUrl) {
    errors.push('REDIS_URL bắt buộc khi REDIS_REQUIRED=true');
  }

  // FCM là tùy chọn. Chỉ bắt buộc bật khi FCM_REQUIRED=true.
  const fcmRequired = bool('FCM_REQUIRED', false);
  const fcmEnabled = bool('FCM_ENABLED', false);
  if (fcmRequired && !fcmEnabled) {
    errors.push('FCM_ENABLED phải là true khi FCM_REQUIRED=true');
  }

  if (!bool('FORCE_HTTPS', true)) errors.push('FORCE_HTTPS production phải là true');

  const origins = csv('CORS_ORIGINS');
  if (!origins.length) errors.push('CORS_ORIGINS production chưa được cấu hình');
  if (origins.some((origin) => origin === '*' || origin.startsWith('http://'))) {
    errors.push('CORS_ORIGINS production không được dùng * hoặc HTTP');
  }

  if (errors.length) {
    const error = new Error(`Production guard từ chối khởi động:\n- ${errors.join('\n- ')}`);
    error.code = 'PRODUCTION_GUARD_FAILED';
    throw error;
  }

  return { production: true, redisRequired, fcmRequired, fcmEnabled };
}

function buildCorsOptions() {
  const production = String(process.env.NODE_ENV || 'development').trim().toLowerCase() === 'production';

  if (!production) {
    return { origin: true, credentials: true };
  }

  const allowed = new Set(csv('CORS_ORIGINS'));

  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      return callback(new Error(`CORS origin không được phép: ${origin}`));
    },
  };
}

module.exports = { assertProductionConfig, buildCorsOptions };
