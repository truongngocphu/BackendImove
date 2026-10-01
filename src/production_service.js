const crypto = require('crypto');

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function safeVersion(value) {
  return String(value || '0.0.0').trim().replace(/^v/i, '').split('+')[0];
}

function compareVersions(a, b) {
  const aa = safeVersion(a).split('.').map((x) => Number(x) || 0);
  const bb = safeVersion(b).split('.').map((x) => Number(x) || 0);
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i += 1) {
    const av = aa[i] || 0;
    const bv = bb[i] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function createProductionService({ getDb, getMongoConnected, getNotifications, getMatching, getDispatch, getSocketServer }) {
  const startedAt = new Date();
  const metrics = {
    requests: 0,
    errors: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    byStatus: {},
    byMethod: {},
  };
  let redisClient = null;
  let redisStatus = String(process.env.REDIS_URL || '').trim() ? 'CONNECTING' : 'NOT_CONFIGURED';
  let redisError = null;

  function requestMetricsMiddleware() {
    return (req, res, next) => {
      const began = process.hrtime.bigint();
      res.on('finish', () => {
        const latency = Number(process.hrtime.bigint() - began) / 1e6;
        metrics.requests += 1;
        metrics.totalLatencyMs += latency;
        metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latency);
        metrics.byStatus[String(res.statusCode)] = (metrics.byStatus[String(res.statusCode)] || 0) + 1;
        metrics.byMethod[req.method] = (metrics.byMethod[req.method] || 0) + 1;
        if (res.statusCode >= 500) metrics.errors += 1;
      });
      next();
    };
  }

  async function startRedis() {
    const url = String(process.env.REDIS_URL || '').trim();
    if (!url) {
      redisStatus = 'NOT_CONFIGURED';
      return false;
    }
    try {
      const { createClient } = require('redis');
      redisClient = createClient({ url, socket: { reconnectStrategy: (retries) => Math.min(5000, 250 * Math.max(1, retries)) } });
      redisClient.on('ready', () => { redisStatus = 'ONLINE'; redisError = null; });
      redisClient.on('reconnecting', () => { redisStatus = 'RECONNECTING'; });
      redisClient.on('error', (error) => { redisStatus = 'ERROR'; redisError = error.message; });
      await redisClient.connect();
      await redisClient.ping();
      redisStatus = 'ONLINE';
      return true;
    } catch (error) {
      redisStatus = 'ERROR';
      redisError = error.message;
      return false;
    }
  }

  async function close() {
    try { if (redisClient?.isOpen) await redisClient.quit(); } catch (_) {}
  }

  async function redisPing() {
    if (!redisClient?.isOpen) return false;
    try { return (await redisClient.ping()) === 'PONG'; } catch (error) { redisError = error.message; return false; }
  }

  function defaultProductionConfig() {
    return {
      maintenanceMode: false,
      maintenanceMessage: 'TH79 iMove đang bảo trì. Vui lòng thử lại sau.',
      minUserVersion: '1.4.0',
      minDriverVersion: '1.4.0',
      latestUserVersion: '1.6.0',
      latestDriverVersion: '1.6.0',
      forceUpdateEnabled: true,
      securityMode: 'PRODUCTION',
      securityPolicyVersion: 2,
      driverRequirements: {
        gpsFreshSeconds: 60,
        heartbeatFreshSeconds: 60,
      },
      securityPolicy: {
        enforceKyc: true,
        enforceRiskRestriction: true,
        requireFcm: true,
        requireTrustedDevice: true,
        requireIntegrity: true,
        requireFace: true,
        requireBiometric: true,
      },
    };
  }

  function normalizeProductionConfig(value = {}) {
    const defaults = defaultProductionConfig();
    const mode = String(value?.securityMode || defaults.securityMode).trim().toUpperCase() === 'TEST' ? 'TEST' : 'PRODUCTION';
    const incomingVersion = num(value?.securityPolicyVersion, 0);
    const legacyPolicy = value?.securityPolicy || {};
    const testMigrationDefaults = mode === 'TEST' && incomingVersion < 2
      ? {
          requireFcm: false,
          requireTrustedDevice: false,
          requireIntegrity: false,
          requireFace: false,
          requireBiometric: false,
        }
      : {};
    const driverRequirements = {
      ...defaults.driverRequirements,
      ...(value?.driverRequirements || {}),
    };
    const securityPolicy = {
      ...defaults.securityPolicy,
      ...legacyPolicy,
      ...testMigrationDefaults,
    };
    return {
      ...defaults,
      ...(value || {}),
      securityMode: mode,
      securityPolicyVersion: 2,
      driverRequirements: {
        gpsFreshSeconds: Math.max(15, num(driverRequirements.gpsFreshSeconds, defaults.driverRequirements.gpsFreshSeconds)),
        heartbeatFreshSeconds: Math.max(15, num(driverRequirements.heartbeatFreshSeconds, defaults.driverRequirements.heartbeatFreshSeconds)),
      },
      securityPolicy: {
        enforceKyc: Boolean(securityPolicy.enforceKyc),
        enforceRiskRestriction: Boolean(securityPolicy.enforceRiskRestriction),
        requireFcm: Boolean(securityPolicy.requireFcm),
        requireTrustedDevice: Boolean(securityPolicy.requireTrustedDevice),
        requireIntegrity: Boolean(securityPolicy.requireIntegrity),
        requireFace: Boolean(securityPolicy.requireFace),
        requireBiometric: Boolean(securityPolicy.requireBiometric),
      },
    };
  }

  async function loadProductionConfig() {
    const db = getDb();
    if (!db) return normalizeProductionConfig();
    const row = await db.collection('app_settings').findOne({ key: 'V73_PRODUCTION_CONFIG' });
    return normalizeProductionConfig(row?.value || {});
  }

  async function saveProductionConfig(value, adminId = null) {
    const db = getDb();
    const current = await loadProductionConfig();
    const next = normalizeProductionConfig({
      ...current,
      ...(value || {}),
      driverRequirements: { ...current.driverRequirements, ...(value?.driverRequirements || {}) },
      securityPolicy: { ...current.securityPolicy, ...(value?.securityPolicy || {}) },
    });
    await db.collection('app_settings').updateOne(
      { key: 'V73_PRODUCTION_CONFIG' },
      { $set: { key: 'V73_PRODUCTION_CONFIG', value: next, status: 'ACTIVE', updatedAt: new Date(), updatedBy: adminId || null }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    return next;
  }

  function appConfigFor({ role, appVersion, config }) {
    const driver = String(role || '').toUpperCase() === 'DRIVER';
    const min = driver ? config.minDriverVersion : config.minUserVersion;
    const latest = driver ? config.latestDriverVersion : config.latestUserVersion;
    const updateRequired = Boolean(config.forceUpdateEnabled) && compareVersions(appVersion || '0.0.0', min) < 0;
    return {
      maintenanceMode: Boolean(config.maintenanceMode),
      maintenanceMessage: config.maintenanceMessage,
      updateRequired,
      minimumVersion: min,
      latestVersion: latest,
      serverVersion: '1.6.0',
      securityMode: config.securityMode,
      securityPolicy: config.securityPolicy,
    };
  }

  async function driverHealth({ driver, user }) {
    const db = getDb();
    const config = await loadProductionConfig();
    const reqs = config.driverRequirements || {};
    const policy = config.securityPolicy || {};
    const mode = String(config.securityMode || 'PRODUCTION').toUpperCase();
    const now = Date.now();
    const [location, device, face, token, trust] = await Promise.all([
      db.collection('driver_locations').findOne({ driverId: driver._id }, { sort: { updatedAt: -1 } }),
      db.collection('trusted_devices').findOne({ userId: user._id, role: 'DRIVER', status: { $ne: 'REVOKED' } }, { sort: { lastSeenAt: -1 } }),
      db.collection('identity_verifications').findOne({ userId: user._id, role: 'DRIVER', status: 'PASSED' }, { sort: { createdAt: -1 } }),
      db.collection('device_tokens').findOne({ userType: 'DRIVER', userId: driver._id, enabled: true }, { sort: { lastSeenAt: -1 } }),
      db.collection('trust_profiles').findOne({ subjectId: user._id, subjectType: 'DRIVER' }),
    ]);
    const heartbeatAge = driver.lastHeartbeatAt ? (now - new Date(driver.lastHeartbeatAt).getTime()) / 1000 : Infinity;
    const locationAge = location?.updatedAt ? (now - new Date(location.updatedAt).getTime()) / 1000 : Infinity;
    const faceAgeHours = face?.createdAt ? (now - new Date(face.createdAt).getTime()) / 3600000 : Infinity;
    const integrity = String(device?.integrity || '').toUpperCase();
    const riskScore = Math.trunc(num(trust?.riskScore));
    const restrictAt = Math.max(50, num(process.env.TRUST_RESTRICT_THRESHOLD, 85));
    const faceMaxHours = Math.max(1, num(process.env.DRIVER_FACE_MAX_HOURS, 12));
    const checks = {
      kyc: { ok: !policy.enforceKyc || (driver.kycStatus === 'APPROVED' && driver.approvalStatus === 'APPROVED'), label: 'KYC & hồ sơ' },
      heartbeat: { ok: heartbeatAge <= num(reqs.heartbeatFreshSeconds, 60), label: 'Kết nối nền', detail: Number.isFinite(heartbeatAge) ? `${Math.round(heartbeatAge)}s` : 'Chưa có heartbeat' },
      gps: { ok: locationAge <= num(reqs.gpsFreshSeconds, 60), label: 'GPS', detail: Number.isFinite(locationAge) ? `${Math.round(locationAge)}s` : 'Chưa có vị trí' },
      fcm: { ok: !policy.requireFcm || Boolean(token), label: 'FCM Push' },
      trustedDevice: { ok: !policy.requireTrustedDevice || device?.trusted === true, label: 'Thiết bị tin cậy' },
      integrity: { ok: !policy.requireIntegrity || ['VERIFIED', 'PLAY_INTEGRITY_OK', 'APP_CHECK_VERIFIED'].includes(integrity), label: 'Play Integrity', detail: integrity || 'UNKNOWN' },
      face: { ok: !policy.requireFace || faceAgeHours <= faceMaxHours, label: 'Xác thực khuôn mặt', detail: Number.isFinite(faceAgeHours) ? `${faceAgeHours.toFixed(1)}h` : 'Chưa xác thực' },
      risk: { ok: !policy.enforceRiskRestriction || riskScore < restrictAt, label: 'Trust & Safety', detail: `Risk ${riskScore}/100` },
    };
    const failures = Object.entries(checks).filter(([, value]) => !value.ok).map(([code, value]) => ({ code, ...value }));
    const blockingFailures = failures.filter((item) => !['heartbeat', 'gps'].includes(item.code));
    const sessionHealthy = ['ONLINE','BUSY'].includes(String(driver.onlineStatus || '').toUpperCase()) ? failures.length === 0 : blockingFailures.length === 0;
    return {
      ok: sessionHealthy,
      canGoOnline: blockingFailures.length === 0,
      checks,
      failures,
      blockingFailures,
      serverTime: new Date(),
      onlineStatus: driver.onlineStatus || 'OFFLINE',
      securityMode: mode,
      securityPolicy: policy,
      faceMaxHours,
      riskScore,
    };
  }

  async function financialSummary() {
    const db = getDb();
    if (!db) return { ok: false };
    const [walletAgg, ledgerAgg, completed, unsettled] = await Promise.all([
      db.collection('wallet_transactions').aggregate([{ $match: { status: 'COMPLETED' } }, { $group: { _id: '$type', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]).toArray(),
      db.collection('platform_ledger_entries').aggregate([{ $group: { _id: '$type', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]).toArray(),
      db.collection('bookings').countDocuments({ status: 'COMPLETED' }),
      db.collection('bookings').countDocuments({ status: 'COMPLETED', $or: [{ 'settlementV73.status': { $ne: 'POSTED' } }, { settlementV73: { $exists: false } }] }),
    ]);
    return {
      completedBookings: completed,
      unsettledBookings: unsettled,
      wallet: Object.fromEntries(walletAgg.map((x) => [x._id, { amount: Math.round(num(x.amount)), count: x.count }])),
      ledger: Object.fromEntries(ledgerAgg.map((x) => [x._id, { amount: Math.round(num(x.amount)), count: x.count }])),
    };
  }

  async function systemHealth() {
    const db = getDb();
    let mongo = false;
    let mongoLatencyMs = null;
    if (db) {
      const start = Date.now();
      try { mongo = (await db.command({ ping: 1 })).ok === 1; } catch (_) { mongo = false; }
      mongoLatencyMs = Date.now() - start;
    }
    const redis = await redisPing();
    const now = new Date();
    const gpsCutoff = new Date(Date.now() - Math.max(15, num(process.env.DRIVER_GPS_FRESH_SECONDS, 60)) * 1000);
    const [onlineDrivers, freshGps, searching, pendingOffers, pushFailed, pushPending] = db ? await Promise.all([
      db.collection('drivers').countDocuments({ onlineStatus: { $in: ['ONLINE', 'BUSY'] } }),
      db.collection('driver_locations').countDocuments({ updatedAt: { $gte: gpsCutoff } }),
      db.collection('bookings').countDocuments({ status: { $in: ['SEARCHING', 'OFFERED'] } }),
      db.collection('booking_offers_v69').countDocuments({ status: 'PENDING', expiresAt: { $gt: now } }),
      db.collection('notification_outbox').countDocuments({ status: 'FAILED' }),
      db.collection('notification_outbox').countDocuments({ status: 'PENDING' }),
    ]) : [0, 0, 0, 0, 0, 0];
    const sockets = getMatching?.()?.socketStats?.()?.connections ?? getSocketServer?.()?.engine?.clientsCount ?? null;
    const avgLatency = metrics.requests ? metrics.totalLatencyMs / metrics.requests : 0;
    const errorRate = metrics.requests ? (metrics.errors / metrics.requests) * 100 : 0;
    const production = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production';
    const redisRequired = boolEnv('REDIS_REQUIRED', production);
    const components = {
      api: { status: 'ONLINE', ok: true },
      mongodb: { status: mongo ? 'ONLINE' : 'OFFLINE', ok: mongo, latencyMs: mongoLatencyMs },
      redis: { status: redis ? 'ONLINE' : redisStatus, ok: redis || !redisRequired, required: redisRequired, error: redisError },
      fcm: { status: getNotifications?.()?.isConfigured?.() ? 'ONLINE' : 'NOT_CONFIGURED', ok: Boolean(getNotifications?.()?.isConfigured?.()) },
      matching: { status: getMatching?.() ? 'ONLINE' : 'OFFLINE', ok: Boolean(getMatching?.()) },
      dispatch: { status: getDispatch?.() ? 'ONLINE' : 'OFFLINE', ok: Boolean(getDispatch?.()) },
      socket: { status: 'ONLINE', ok: true, connections: sockets },
    };
    return {
      ok: Object.values(components).every((x) => x.ok),
      service: 'TH79_IMOVE_CORE',
      version: '1.4.0',
      environment: process.env.NODE_ENV || 'development',
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      components,
      metrics: {
        requests: metrics.requests,
        errors: metrics.errors,
        errorRatePercent: Number(errorRate.toFixed(2)),
        avgLatencyMs: Number(avgLatency.toFixed(1)),
        maxLatencyMs: Number(metrics.maxLatencyMs.toFixed(1)),
        onlineDrivers,
        freshGps,
        searchingBookings: searching,
        pendingOffers,
        pushFailed,
        pushPending,
      },
      generatedAt: new Date(),
    };
  }

  function fareSnapshot(quote) {
    const q = quote || {};
    return {
      snapshotId: crypto.randomUUID(),
      serviceCode: q.serviceCode || 'BIKE',
      areaCode: q.areaCode || 'GLOBAL',
      currency: q.currency || 'VND',
      baseFare: Math.round(num(q.baseFare)),
      distanceFare: Math.round(num(q.distanceFare)),
      timeFare: Math.round(num(q.timeFare)),
      surchargeTotal: Math.round(num(q.surchargeTotal)),
      surcharges: Array.isArray(q.surcharges) ? q.surcharges : [],
      bookingFee: Math.round(num(q.bookingFee)),
      customerServiceFee: Math.round(num(q.customerServiceFee)),
      paymentFee: Math.round(num(q.paymentFee)),
      platformCommission: Math.round(num(q.platformCommission)),
      driverFixedFee: Math.round(num(q.driverFixedFee)),
      driverGrossAmount: Math.round(num(q.driverGrossAmount)),
      driverNetAmount: Math.round(num(q.driverNetAmount)),
      customerTotal: Math.round(num(q.customerTotal)),
      platformRevenueEstimate: Math.round(num(q.platformRevenueEstimate)),
      fareConfigVersion: num(q.fareConfigVersion),
      platformFeeVersion: num(q.platformFeeVersion),
      fareConfigId: q.fareConfigId || null,
      platformFeeId: q.platformFeeId || null,
      calculatedAt: q.calculatedAt || new Date(),
      capturedAt: new Date(),
    };
  }

  async function postSettlement(booking) {
    const db = getDb();
    if (!db || !booking?._id || booking.status !== 'COMPLETED') return null;
    const snap = booking.fareSnapshot || fareSnapshot(booking.pricing || {});
    const referenceBase = `BOOKING:${String(booking._id)}`;
    const entries = [
      { type: 'CUSTOMER_GROSS_FARE', amount: Math.round(num(snap.customerTotal)) },
      { type: 'DRIVER_NET_EARNING', amount: Math.round(num(snap.driverNetAmount)) },
      { type: 'PLATFORM_REVENUE', amount: Math.round(num(snap.platformRevenueEstimate)) },
    ].filter((x) => x.amount !== 0);
    for (const entry of entries) {
      await db.collection('platform_ledger_entries').updateOne(
        { reference: `${referenceBase}:${entry.type}` },
        { $setOnInsert: { bookingId: booking._id, bookingCode: booking.bookingCode, type: entry.type, amount: entry.amount, currency: snap.currency || 'VND', reference: `${referenceBase}:${entry.type}`, fareSnapshot: snap, createdAt: new Date() } },
        { upsert: true },
      );
    }
    await db.collection('bookings').updateOne(
      { _id: booking._id },
      { $set: { fareSnapshot: snap, settlementV73: { status: 'POSTED', postedAt: new Date(), ledgerVersion: 1 }, updatedAt: new Date() } },
    );
    return { ok: true, entries: entries.length };
  }

  async function databaseReady() {
    const db = getDb();
    if (!db) return;
    await Promise.all([
      db.collection('platform_ledger_entries').createIndex({ reference: 1 }, { unique: true, name: 'uq_v73_ledger_reference' }),
      db.collection('platform_ledger_entries').createIndex({ bookingId: 1, createdAt: -1 }, { name: 'idx_v73_ledger_booking' }),
      db.collection('bookings').createIndex({ status: 1, 'settlementV73.status': 1, completedAt: -1 }, { name: 'idx_v73_settlement' }),
    ]).catch((error) => console.warn('[V7.3 indexes]', error.message));
  }

  return {
    requestMetricsMiddleware,
    startRedis,
    close,
    databaseReady,
    loadProductionConfig,
    saveProductionConfig,
    normalizeProductionConfig,
    appConfigFor,
    driverHealth,
    financialSummary,
    systemHealth,
    fareSnapshot,
    postSettlement,
  };
}

module.exports = { createProductionService, compareVersions };
