function bool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
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
  if (bool('LAN_DISCOVERY_ENABLED', false)) errors.push('LAN_DISCOVERY_ENABLED phải là false trên VPS production');
  if (bool('SERVICE_REGISTRY_ENABLED', false)) errors.push('SERVICE_REGISTRY_ENABLED phải là false khi dùng URL Backend cố định');
  if (bool('MATCHING_ALLOW_NO_GPS_FALLBACK', false)) errors.push('MATCHING_ALLOW_NO_GPS_FALLBACK phải là false');
  if (bool('SEED_DEMO_ON_START', false)) errors.push('SEED_DEMO_ON_START phải là false');
  if (!bool('TRUST_MATCHING_ENFORCEMENT', true)) errors.push('TRUST_MATCHING_ENFORCEMENT phải là true');

  const faceMode = String(process.env.FACE_PROVIDER_MODE || 'MANUAL').toUpperCase();
  if (faceMode === 'DEV') errors.push('FACE_PROVIDER_MODE production không được là DEV');
  const faceKey = String(process.env.FACE_EVIDENCE_KEY || process.env.KYC_DATA_KEY || '');
  if (faceKey.length < 32) errors.push('FACE_EVIDENCE_KEY hoặc KYC_DATA_KEY phải >= 32 ký tự');

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
  if (redisRequired && !redisUrl) errors.push('REDIS_REQUIRED=true nhưng REDIS_URL chưa được cấu hình');

  const forceHttps = bool('FORCE_HTTPS', true);
  const tlsByProxy = bool('TLS_TERMINATED_BY_PROXY', false);
  if (!forceHttps && !tlsByProxy) {
    errors.push('Production phải bật FORCE_HTTPS=true hoặc TLS_TERMINATED_BY_PROXY=true');
  }

  const origins = csv('CORS_ORIGINS');
  if (!origins.length) errors.push('CORS_ORIGINS production chưa được cấu hình');
  if (origins.some((x) => x === '*' || x.startsWith('http://'))) {
    errors.push('CORS_ORIGINS production không được dùng * hoặc HTTP');
  }

  const publicUrl = String(process.env.CORE_PUBLIC_URL || '').trim();
  if (!/^https:\/\//i.test(publicUrl)) errors.push('CORE_PUBLIC_URL production phải là HTTPS public URL');

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
  const allowed = new Set(csv('CORS_ORIGINS'));
  return {
    credentials: true,
    origin(origin, callback) {
      // Native apps và server-to-server thường không có Origin header.
      if (!origin || allowed.has(origin)) return callback(null, true);
      const error = new Error('CORS origin không được phép.');
      error.code = 'CORS_ORIGIN_DENIED';
      error.origin = origin;
      console.warn(`[CORS] Origin bị chặn: ${JSON.stringify(origin)}`);
      return callback(error);
    },
  };
}

module.exports = { assertProductionConfig, buildCorsOptions };
