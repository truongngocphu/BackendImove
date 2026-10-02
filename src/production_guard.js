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
  const production = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production';
  if (!production) return { production: false };

  const errors = [];
  if (bool('AUTH_DEV_SHOW_OTP', false)) errors.push('AUTH_DEV_SHOW_OTP phải là false');
  if (bool('V64_DEMO_TOPUP_ENABLED', false)) errors.push('V64_DEMO_TOPUP_ENABLED phải là false');
  if (bool('LAN_DISCOVERY_ENABLED', false)) errors.push('LAN_DISCOVERY_ENABLED phải là false');
  if (bool('MATCHING_ALLOW_NO_GPS_FALLBACK', false)) errors.push('MATCHING_ALLOW_NO_GPS_FALLBACK phải là false');
  if (bool('SEED_DEMO_ON_START', false)) errors.push('SEED_DEMO_ON_START phải là false');
  // Firebase App Check is not a required dependency in the MongoDB-first build.
  // Enable APP_INTEGRITY_REQUIRED only after configuring a non-Firebase provider.
  if (!bool('TRUST_MATCHING_ENFORCEMENT', true)) errors.push('TRUST_MATCHING_ENFORCEMENT phải là true');
  const faceMode = String(process.env.FACE_PROVIDER_MODE || 'MANUAL').toUpperCase();
  if (faceMode === 'DEV') errors.push('FACE_PROVIDER_MODE production không được là DEV');
  const faceKey = String(process.env.FACE_EVIDENCE_KEY || process.env.KYC_DATA_KEY || '');
  if (faceKey.length < 32) errors.push('FACE_EVIDENCE_KEY hoặc KYC_DATA_KEY phải >= 32 ký tự để mã hóa face evidence');

  // FCM is optional. Notifications are persisted/delivered in-app through MongoDB.
  const accessSecret = String(process.env.JWT_ACCESS_SECRET || '');
  if (accessSecret.length < 32 || /CHANGE_TO|changeme|secret/i.test(accessSecret)) {
    errors.push('JWT_ACCESS_SECRET phải là secret production >= 32 ký tự');
  }

  const mongoUri = String(process.env.MONGODB_URI || '');
  if (!/^mongodb(\+srv)?:\/\//i.test(mongoUri) || /USERNAME|PASSWORD|YOUR_/i.test(mongoUri)) {
    errors.push('MONGODB_URI production chưa hợp lệ');
  }

  const redisRequired = bool('REDIS_REQUIRED', false);
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  if (redisRequired && !redisUrl) errors.push('REDIS_URL bắt buộc khi REDIS_REQUIRED=true');
  if (!bool('FORCE_HTTPS', true)) errors.push('FORCE_HTTPS production phải là true');

  const origins = csv('CORS_ORIGINS');
  if (!origins.length) errors.push('CORS_ORIGINS production chưa được cấu hình');
  if (origins.some((x) => x === '*' || x.startsWith('http://'))) {
    errors.push('CORS_ORIGINS production không được dùng * hoặc HTTP');
  }
  if (origins.some((x) => x.includes('*') && !/^https:\/\/\*\.[A-Za-z0-9.-]+$/.test(x))) {
    errors.push('CORS wildcard chỉ hỗ trợ dạng https://*.example.com');
  }

  if (errors.length) {
    const error = new Error(`Production guard từ chối khởi động:\n- ${errors.join('\n- ')}`);
    error.code = 'PRODUCTION_GUARD_FAILED';
    throw error;
  }
  return { production: true };
}

function buildCorsOptions() {
  const production = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production';
  if (!production) return { origin: true, credentials: true };
  const configured = csv('CORS_ORIGINS');
  const allowed = new Set(configured.filter((x) => !x.includes('*')));
  const wildcardHosts = configured
    .filter((x) => /^https:\/\/\*\.[A-Za-z0-9.-]+$/.test(x))
    .map((x) => x.slice('https://*.'.length).toLowerCase());

  function originAllowed(origin) {
    if (!origin) return true; // Native apps/server-to-server.
    if (allowed.has(origin)) return true;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:') return false;
      const host = url.hostname.toLowerCase();
      return wildcardHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    } catch (_) {
      return false;
    }
  }

  return {
    credentials: true,
    origin(origin, callback) {
      if (originAllowed(origin)) return callback(null, true);
      const error = new Error(`CORS origin không được phép: ${origin || '(none)'}`);
      error.code = 'CORS_ORIGIN_DENIED';
      error.status = 403;
      return callback(error);
    },
  };
}

module.exports = { assertProductionConfig, buildCorsOptions };
