const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { Server: SocketIOServer } = require('socket.io');
const {
  DEFAULT_MATCHING_POLICY,
  MATCHING_PRESETS,
  normalizeMatchingPolicy,
  rankMatchingCandidates,
} = require('./matching_policy');
const { driverCanServe } = require('./service_catalog_service');

function asInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function asFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function asBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function safeObjectId(value) {
  try { return new ObjectId(String(value)); } catch (_) { return null; }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeFindOneAndUpdate(result) {
  if (!result) return null;
  if (result._id) return result;
  if (result.value && result.value._id) return result.value;
  return null;
}

function createMatchingEngine({
  server,
  getDb,
  serializeBooking,
  addEvent,
}) {
  const config = {
    enabled: asBool(process.env.MATCHING_ENABLED, true),
    offerTimeoutSeconds: asInt(process.env.MATCHING_OFFER_TIMEOUT_SECONDS, 20, 5, 120),
    searchRetrySeconds: asInt(process.env.MATCHING_SEARCH_RETRY_SECONDS, 5, 2, 60),
    maxRadiusKm: asFloat(process.env.MATCHING_MAX_RADIUS_KM, 8, 0.5, 100),
    locationFreshSeconds: asInt(process.env.MATCHING_LOCATION_FRESH_SECONDS, 45, 10, 300),
    locationTtlSeconds: asInt(process.env.MATCHING_LOCATION_TTL_SECONDS, 120, 30, 900),
    maxCandidates: asInt(process.env.MATCHING_MAX_CANDIDATES, 50, 5, 200),
    allowNoGpsFallback: asBool(process.env.MATCHING_ALLOW_NO_GPS_FALLBACK, true),
    strictAccept: asBool(process.env.MATCHING_STRICT_ACCEPT, true),
    singleOfferPerBooking: true,
  };

  const activeTripStatuses = [
    'DRIVER_ASSIGNED',
    'DRIVER_ARRIVING',
    'DRIVER_ARRIVED',
    'IN_PROGRESS',
  ];

  const runtimePolicyDefaults = {
    ...DEFAULT_MATCHING_POLICY,
    autoDispatchEnabled: config.enabled,
    offerTimeoutSeconds: config.offerTimeoutSeconds,
    searchRetrySeconds: config.searchRetrySeconds,
    maxRadiusKm: config.maxRadiusKm,
    locationFreshSeconds: config.locationFreshSeconds,
    maxCandidates: config.maxCandidates,
    allowNoGpsFallback: config.allowNoGpsFallback,
  };

  let policyCache = null;
  let policyCacheAt = 0;

  async function getMatchingPolicy({ refresh = false } = {}) {
    const db = getDb();
    const nowMs = Date.now();
    if (!refresh && policyCache && nowMs - policyCacheAt < 5000) return policyCache;
    if (!db) return normalizeMatchingPolicy({}, runtimePolicyDefaults);

    const stored = await db.collection('matching_policies').findOne({
      key: 'BIKE_MATCHING_POLICY',
    });
    policyCache = normalizeMatchingPolicy(stored || {}, runtimePolicyDefaults);
    policyCacheAt = nowMs;
    return policyCache;
  }

  async function saveMatchingPolicy(raw, adminId = null) {
    const db = getDb();
    if (!db) throw new Error('MongoDB Atlas chưa sẵn sàng.');
    const current = await getMatchingPolicy({ refresh: true });
    const normalized = normalizeMatchingPolicy({
      ...raw,
      version: Number(current.version || 1) + 1,
    }, runtimePolicyDefaults);
    const changedAt = new Date();
    await db.collection('matching_policies').updateOne(
      { key: 'BIKE_MATCHING_POLICY' },
      {
        $set: {
          ...normalized,
          updatedAt: changedAt,
          updatedBy: adminId || null,
        },
        $setOnInsert: { createdAt: changedAt },
      },
      { upsert: true },
    );
    await db.collection('dispatch_configs').updateOne(
      { key: 'BIKE_V69_DISPATCH' },
      {
        $set: {
          enabled: normalized.autoDispatchEnabled,
          updatedAt: changedAt,
          updatedBy: adminId || null,
          source: 'MATCHING_POLICY_SYNC',
        },
        $setOnInsert: { createdAt: changedAt },
      },
      { upsert: true },
    );
    policyCache = normalized;
    policyCacheAt = Date.now();
    if (normalized.autoDispatchEnabled) {
      setImmediate(() => resumeSearchingBookings().catch((error) => {
        console.error('[Matching] Auto dispatch resume failed:', error.message);
      }));
    }
    return normalized;
  }

  function invalidateMatchingPolicyCache() {
    policyCache = null;
    policyCacheAt = 0;
  }

  const timers = new Map();
  let io = null;
  let started = false;
  let sweeping = null;

  function roomUser(userId) {
    return `user:${String(userId)}`;
  }

  function roomDriver(driverId) {
    return `driver:${String(driverId)}`;
  }

  function roomBooking(bookingId) {
    return `booking:${String(bookingId)}`;
  }

  function emitToDriver(driverId, eventName, payload) {
    if (!io || !driverId) return;
    io.to(roomDriver(driverId)).emit(eventName, payload);
  }

  function emitToUser(userId, eventName, payload) {
    if (!io || !userId) return;
    io.to(roomUser(userId)).emit(eventName, payload);
  }

  function serializeBookingPublic(booking) {
    return booking ? serializeBooking(booking) : null;
  }

  function emitBookingUpdate(booking, eventName = 'booking:update') {
    if (!io || !booking) return;
    const payload = serializeBooking(booking);
    io.to(roomUser(booking.customerId)).emit(eventName, payload);
    if (booking.driverId) {
      io.to(roomDriver(booking.driverId)).emit(eventName, payload);
    }
    io.to(roomBooking(booking._id)).emit(eventName, payload);
  }

  async function repairMultipleActiveOffers() {
    const db = getDb();
    if (!db) return { repairedBookings: 0, cancelledOffers: 0 };

    const groups = await db.collection('driver_offers').aggregate([
      { $match: { status: 'SENT' } },
      {
        $group: {
          _id: '$bookingId',
          count: { $sum: 1 },
          offerIds: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    let cancelledOffers = 0;

    for (const group of groups) {
      const booking = await db.collection('bookings').findOne(
        { _id: group._id },
        { projection: { 'dispatch.currentDriverId': 1 } },
      );

      const offers = await db.collection('driver_offers').find({
        _id: { $in: group.offerIds },
        status: 'SENT',
      }).sort({ sentAt: 1, _id: 1 }).toArray();

      if (offers.length <= 1) continue;

      const preferredDriverId = booking?.dispatch?.currentDriverId
        ? String(booking.dispatch.currentDriverId)
        : null;

      const keeper = (
        offers.find((offer) => String(offer.driverId) === preferredDriverId)
        || offers[0]
      );

      const duplicates = offers.filter(
        (offer) => String(offer._id) !== String(keeper._id),
      );

      if (duplicates.length === 0) continue;

      const changedAt = new Date();
      await db.collection('driver_offers').updateMany(
        { _id: { $in: duplicates.map((item) => item._id) }, status: 'SENT' },
        {
          $set: {
            status: 'CANCELLED',
            reason: 'DUPLICATE_ACTIVE_OFFER_REPAIRED',
            respondedAt: changedAt,
            updatedAt: changedAt,
          },
        },
      );

      for (const duplicate of duplicates) {
        await releaseOfferLock(duplicate.driverId, group._id);
        emitToDriver(duplicate.driverId, 'driver:offer_closed', {
          bookingId: String(group._id),
          status: 'CANCELLED',
          reason: 'DUPLICATE_ACTIVE_OFFER_REPAIRED',
        });
      }

      cancelledOffers += duplicates.length;
    }

    if (groups.length > 0) {
      console.log(
        `[Matching] Repaired ${groups.length} booking(s), `
        + `cancelled ${cancelledOffers} duplicate active offer(s).`,
      );
    }

    return {
      repairedBookings: groups.length,
      cancelledOffers,
    };
  }

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;

    await repairMultipleActiveOffers();

    await Promise.all([
      db.collection('driver_locations').createIndex(
        { driverId: 1 },
        { unique: true, name: 'uq_driver_locations_driver' },
      ),
      db.collection('driver_locations').createIndex(
        { location: '2dsphere' },
        { name: 'geo_driver_locations' },
      ),
      db.collection('driver_locations').createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'ttl_driver_locations' },
      ),
      db.collection('driver_offers').createIndex(
        { bookingId: 1, driverId: 1 },
        { unique: true, name: 'uq_driver_offer_booking_driver' },
      ),
      db.collection('driver_offers').createIndex(
        { bookingId: 1 },
        {
          unique: true,
          name: 'uq_one_active_sent_offer_per_booking',
          partialFilterExpression: { status: 'SENT' },
        },
      ),
      db.collection('driver_offers').createIndex(
        { driverId: 1, status: 1, expiresAt: 1 },
        { name: 'idx_driver_offers_active' },
      ),
      db.collection('bookings').createIndex(
        { status: 1, createdAt: 1 },
        { name: 'idx_bookings_matching_queue' },
      ),
      db.collection('drivers').createIndex(
        { approvalStatus: 1, kycStatus: 1, onlineStatus: 1 },
        { name: 'idx_drivers_matching_eligibility' },
      ),
      db.collection('vehicles').createIndex(
        { driverId: 1, serviceCode: 1, status: 1 },
        { name: 'idx_vehicles_matching' },
      ),
      db.collection('matching_policies').createIndex(
        { key: 1 },
        { unique: true, name: 'uq_matching_policy_key' },
      ),
      db.collection('matching_admin_logs').createIndex(
        { createdAt: -1 },
        { name: 'idx_matching_admin_logs_created' },
      ),
    ]);
  }

  async function acquireDispatchLock(bookingId) {
    const db = getDb();
    if (!db) return null;

    const changedAt = new Date();
    const token = crypto.randomUUID();
    const lockUntil = new Date(changedAt.getTime() + 5000);

    const result = await db.collection('bookings').findOneAndUpdate(
      {
        _id: bookingId,
        status: 'SEARCHING',
        $or: [
          { matchingLockUntil: { $exists: false } },
          { matchingLockUntil: null },
          { matchingLockUntil: { $lte: changedAt } },
        ],
      },
      {
        $set: {
          matchingLockToken: token,
          matchingLockUntil: lockUntil,
          updatedAt: changedAt,
        },
      },
      { returnDocument: 'after' },
    );

    const booking = normalizeFindOneAndUpdate(result);
    return booking ? { token, booking } : null;
  }

  async function releaseDispatchLock(bookingId, token) {
    const db = getDb();
    if (!db || !bookingId || !token) return;

    await db.collection('bookings').updateOne(
      { _id: bookingId, matchingLockToken: token },
      {
        $set: {
          matchingLockToken: null,
          matchingLockUntil: null,
          updatedAt: new Date(),
        },
      },
    );
  }

  async function getBookingSearchTimeoutSeconds() {
    const db = getDb();
    const fallback = asInt(process.env.BOOKING_SEARCH_TIMEOUT_SECONDS, 300, 60, 3600);
    if (!db) return fallback;
    try {
      const setting = await db.collection('app_settings').findOne({
        key: 'BIKE_BOOKING_CONFIG',
        status: 'ACTIVE',
      });
      return asInt(setting?.value?.bookingTimeoutSeconds, fallback, 60, 3600);
    } catch (_) {
      return fallback;
    }
  }

  function driverServiceEnabled(driver, serviceCode) {
    const code = String(serviceCode || 'BIKE').toUpperCase();
    const approved = Array.isArray(driver?.approvedServiceCodes)
      ? driver.approvedServiceCodes.map((x) => String(x || '').toUpperCase()).filter(Boolean)
      : [];
    const prefs = driver?.servicePreferences && typeof driver.servicePreferences === 'object'
      ? driver.servicePreferences
      : null;
    if (approved.length) {
      return approved.includes(code) && !(prefs && prefs[code] === false);
    }
    const legacy = Array.isArray(driver?.serviceCapabilities)
      ? driver.serviceCapabilities.map((x) => String(x || '').toUpperCase()).filter(Boolean)
      : [];
    if (!legacy.length) return true;
    if (prefs && prefs[code] === false) return false;
    if (legacy.includes(code)) return true;
    if (['FOOD','ERRAND','DELIVERY'].includes(code) && legacy.includes('BIKE')) return true;
    return false;
  }

  async function getDriverContextById(driverId, serviceCode = null) {
    const db = getDb();
    if (!db) return null;
    const driver = await db.collection('drivers').findOne({ _id: driverId });
    if (!driver) return null;
    if (serviceCode && !driverServiceEnabled(driver, serviceCode)) return null;
    const user = await db.collection('users').findOne({ _id: driver.userId });
    const vehicleQuery = { driverId: driver._id, status: 'APPROVED' };
    if (serviceCode) vehicleQuery.$or = [{ serviceCodes: String(serviceCode).toUpperCase() }, { serviceCode: String(serviceCode).toUpperCase() }];
    const vehicle = await db.collection('vehicles').findOne(vehicleQuery);
    if (!user) return null;
    return { user, driver, vehicle };
  }

  async function hasActiveBooking(driverId, exceptBookingId = null) {
    const db = getDb();
    if (!db) return true;
    const query = {
      driverId,
      status: { $in: activeTripStatuses },
    };
    if (exceptBookingId) query._id = { $ne: exceptBookingId };
    const existing = await db.collection('bookings').findOne(query, { projection: { _id: 1 } });
    return Boolean(existing);
  }

  async function updateLocationByDriverId(driverId, userId, payload) {
    const db = getDb();
    if (!db) throw new Error('MongoDB Atlas chưa sẵn sàng.');

    const latitude = Number(payload?.latitude);
    const longitude = Number(payload?.longitude);
    const heading = payload?.heading == null ? null : Number(payload.heading);
    const speedKph = payload?.speedKph == null ? null : Number(payload.speedKph);
    const accuracyM = payload?.accuracyM == null ? null : Number(payload.accuracyM);

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error('Latitude không hợp lệ.');
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('Longitude không hợp lệ.');
    }

    const driver = await db.collection('drivers').findOne({ _id: driverId });
    if (!driver) throw new Error('Không tìm thấy tài xế.');
    if (driver.approvalStatus !== 'APPROVED' || driver.kycStatus !== 'APPROVED') {
      throw new Error('Tài xế chưa đủ điều kiện KYC để gửi vị trí.');
    }
    if (!['ONLINE', 'BUSY'].includes(driver.onlineStatus)) {
      const error = new Error('Tài xế phải ONLINE hoặc BUSY mới gửi vị trí.');
      error.code = 'DRIVER_OFFLINE';
      throw error;
    }

    const changedAt = new Date();
    const expiresAt = new Date(changedAt.getTime() + config.locationTtlSeconds * 1000);
    const doc = {
      driverId,
      userId: userId || driver.userId,
      location: {
        type: 'Point',
        coordinates: [longitude, latitude],
      },
      heading: Number.isFinite(heading) ? heading : null,
      speedKph: Number.isFinite(speedKph) ? Math.max(0, speedKph) : null,
      accuracyM: Number.isFinite(accuracyM) ? Math.max(0, accuracyM) : null,
      updatedAt: changedAt,
      expiresAt,
    };

    await db.collection('driver_locations').updateOne(
      { driverId },
      { $set: doc, $setOnInsert: { createdAt: changedAt } },
      { upsert: true },
    );
    await db.collection('drivers').updateOne(
      { _id: driverId },
      { $set: { lastHeartbeatAt: changedAt, lastLocationAt: changedAt, updatedAt: changedAt } },
    );

    if (driver.activeBookingId) {
      const booking = await db.collection('bookings').findOne({
        _id: driver.activeBookingId,
        driverId,
        status: { $in: activeTripStatuses },
      });
      if (booking && io) {
        const locationPayload = {
          bookingId: String(booking._id),
          driverId: String(driverId),
          latitude,
          longitude,
          heading: doc.heading,
          speedKph: doc.speedKph,
          accuracyM: doc.accuracyM,
          updatedAt: changedAt.toISOString(),
        };
        io.to(roomUser(booking.customerId)).emit('driver:location', locationPayload);
        io.to(roomBooking(booking._id)).emit('driver:location', locationPayload);
      }
    }

    return {
      ok: true,
      latitude,
      longitude,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function updateLocationByContext(context, payload) {
    return updateLocationByDriverId(
      context.driver._id,
      context.user._id,
      payload,
    );
  }

  async function findGpsCandidates(booking, excludedDriverIds, policy) {
    const db = getDb();
    const pickupCoordinates = booking?.pickup?.location?.coordinates;
    if (!Array.isArray(pickupCoordinates) || pickupCoordinates.length < 2) return [];

    const pickupLon = Number(pickupCoordinates[0]);
    const pickupLat = Number(pickupCoordinates[1]);
    if (!Number.isFinite(pickupLon) || !Number.isFinite(pickupLat)) return [];
    if (pickupLat === 0 && pickupLon === 0) return [];

    const freshCutoff = new Date(Date.now() - policy.locationFreshSeconds * 1000);
    const maxDistanceM = policy.maxRadiusKm * 1000;

    let locations = [];
    try {
      locations = await db.collection('driver_locations').find({
        location: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: [pickupLon, pickupLat],
            },
            $maxDistance: maxDistanceM,
          },
        },
        updatedAt: { $gte: freshCutoff },
      }).limit(policy.maxCandidates).toArray();
    } catch (error) {
      console.warn('[Matching] Geo query failed:', error.message);
      return [];
    }

    const candidates = [];

    for (const location of locations) {
      const driverId = location.driverId;
      if (!driverId || excludedDriverIds.has(String(driverId))) continue;

      const context = await getDriverContextById(driverId, booking.serviceCode || 'BIKE');
      if (!context?.vehicle) continue;
      if (context.driver.approvalStatus !== 'APPROVED') continue;
      if (context.driver.kycStatus !== 'APPROVED') continue;
      if (context.driver.onlineStatus !== 'ONLINE') continue;
      if (await hasActiveBooking(driverId)) continue;

      const coords = location.location?.coordinates || [];
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      const distanceKm =
        Number.isFinite(lat) && Number.isFinite(lon)
          ? haversineKm(pickupLat, pickupLon, lat, lon)
          : null;

      candidates.push({
        ...context,
        location,
        distanceKm,
        source: 'GPS',
      });
    }

    return candidates;
  }

  async function findNoGpsFallbackCandidates(booking, excludedDriverIds, policy) {
    if (!policy.allowNoGpsFallback) return [];
    const db = getDb();
    const drivers = await db.collection('drivers').find({
      approvalStatus: 'APPROVED',
      kycStatus: 'APPROVED',
      onlineStatus: 'ONLINE',
    }).sort({ rating: -1, updatedAt: 1 }).limit(policy.maxCandidates).toArray();

    const candidates = [];
    for (const driver of drivers) {
      if (excludedDriverIds.has(String(driver._id))) continue;
      if (await hasActiveBooking(driver._id)) continue;
      const context = await getDriverContextById(driver._id, booking?.serviceCode || 'BIKE');
      if (!context?.vehicle) continue;
      candidates.push({
        ...context,
        location: null,
        distanceKm: null,
        source: 'NO_GPS_FALLBACK',
      });
    }
    return candidates;
  }

  async function acquireOfferLock(driverId, bookingId, expiresAt) {
    const db = getDb();
    const changedAt = new Date();
    const result = await db.collection('drivers').updateOne(
      {
        _id: driverId,
        approvalStatus: 'APPROVED',
        kycStatus: 'APPROVED',
        onlineStatus: 'ONLINE',
        $or: [
          { currentOfferBookingId: { $exists: false } },
          { currentOfferBookingId: null },
          { currentOfferExpiresAt: { $lte: changedAt } },
        ],
      },
      {
        $set: {
          currentOfferBookingId: bookingId,
          currentOfferExpiresAt: expiresAt,
          updatedAt: changedAt,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async function releaseOfferLock(driverId, bookingId) {
    const db = getDb();
    if (!db || !driverId) return;
    await db.collection('drivers').updateOne(
      { _id: driverId, currentOfferBookingId: bookingId },
      {
        $set: {
          currentOfferBookingId: null,
          currentOfferExpiresAt: null,
          updatedAt: new Date(),
        },
      },
    );
  }

  function clearTimer(bookingId) {
    const key = String(bookingId);
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  function setTimer(bookingId, delayMs, callback) {
    clearTimer(bookingId);
    const timer = setTimeout(async () => {
      timers.delete(String(bookingId));
      try { await callback(); } catch (error) {
        console.error('[Matching] Timer error:', error.message);
      }
    }, Math.max(250, delayMs));
    timer.unref?.();
    timers.set(String(bookingId), timer);
  }

  async function scheduleOfferTimeout(bookingId, driverId, expiresAt) {
    const delay = Math.max(250, new Date(expiresAt).getTime() - Date.now() + 100);
    setTimer(bookingId, delay, () => expireOfferAndDispatchNext(bookingId, driverId));
  }

  async function expireBooking(bookingId, reason = 'SEARCH_TIMEOUT') {
    const db = getDb();
    const changedAt = new Date();
    const result = await db.collection('bookings').findOneAndUpdate(
      { _id: bookingId, status: 'SEARCHING' },
      {
        $set: {
          status: 'EXPIRED',
          expiredAt: changedAt,
          updatedAt: changedAt,
          'dispatch.status': 'EXPIRED',
          'dispatch.finishedAt': changedAt,
        },
      },
      { returnDocument: 'after' },
    );
    const booking = normalizeFindOneAndUpdate(result);
    if (!booking) return null;

    const sentOffers = await db.collection('driver_offers').find({
      bookingId,
      status: 'SENT',
    }).toArray();

    await db.collection('driver_offers').updateMany(
      { bookingId, status: 'SENT' },
      { $set: { status: 'CANCELLED', respondedAt: changedAt, updatedAt: changedAt } },
    );

    for (const offer of sentOffers) {
      await releaseOfferLock(offer.driverId, bookingId);
      emitToDriver(offer.driverId, 'driver:offer_expired', {
        bookingId: String(bookingId),
        reason,
      });
    }

    await addEvent(bookingId, 'BOOKING_EXPIRED', 'SYSTEM', null, { reason });
    emitBookingUpdate(booking);
    clearTimer(bookingId);
    return booking;
  }

  async function expireOfferAndDispatchNext(bookingId, driverId) {
    const db = getDb();
    const changedAt = new Date();
    const offer = await db.collection('driver_offers').findOne({
      bookingId,
      driverId,
      status: 'SENT',
    });

    if (!offer) return;

    const booking = await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking || booking.status !== 'SEARCHING') {
      await db.collection('driver_offers').updateOne(
        { _id: offer._id, status: 'SENT' },
        { $set: { status: 'CANCELLED', respondedAt: changedAt, updatedAt: changedAt } },
      );
      await releaseOfferLock(driverId, bookingId);
      return;
    }

    await db.collection('driver_offers').updateOne(
      { _id: offer._id, status: 'SENT' },
      { $set: { status: 'EXPIRED', respondedAt: changedAt, updatedAt: changedAt } },
    );
    await releaseOfferLock(driverId, bookingId);
    await addEvent(bookingId, 'DRIVER_OFFER_EXPIRED', 'SYSTEM', driverId, {
      offerTimeoutSeconds: config.offerTimeoutSeconds,
    });
    emitToDriver(driverId, 'driver:offer_expired', {
      bookingId: String(bookingId),
      reason: 'TIMEOUT',
    });
    await dispatchBooking(bookingId, { force: true });
  }

  async function dispatchBooking(rawBookingId, { force = false, manual = false } = {}) {
    if (!config.enabled) return null;
    const db = getDb();
    if (!db) return null;
    const policy = await getMatchingPolicy();

    const bookingId = rawBookingId instanceof ObjectId
      ? rawBookingId
      : safeObjectId(rawBookingId);
    if (!bookingId) return null;

    if (!policy.autoDispatchEnabled && !manual) {
      const activeOffer = await db.collection('driver_offers').findOne({
        bookingId,
        status: 'SENT',
        expiresAt: { $gt: new Date() },
      });
      if (!activeOffer) {
        await db.collection('bookings').updateOne(
          { _id: bookingId, status: 'SEARCHING' },
          {
            $set: {
              'dispatch.status': 'AUTO_PAUSED',
              'dispatch.mode': 'ADMIN_CONTROL',
              'dispatch.currentDriverId': null,
              'dispatch.updatedAt': new Date(),
              updatedAt: new Date(),
            },
          },
        );
      }
      return activeOffer || null;
    }

    const lock = await acquireDispatchLock(bookingId);

    if (!lock) {
      const existingOffer = await db.collection('driver_offers').findOne({
        bookingId,
        status: 'SENT',
        expiresAt: { $gt: new Date() },
      });

      if (existingOffer) {
        await scheduleOfferTimeout(
          bookingId,
          existingOffer.driverId,
          existingOffer.expiresAt,
        );
      }

      return existingOffer || null;
    }

    const lockToken = lock.token;

    try {
      const booking = await db.collection('bookings').findOne({ _id: bookingId });
      if (!booking || booking.status !== 'SEARCHING') {
        clearTimer(bookingId);
        return null;
      }

      const searchTimeoutSeconds = await getBookingSearchTimeoutSeconds();
      const ageMs = Date.now() - new Date(
        booking.createdAt || booking.requestedAt || Date.now(),
      ).getTime();

      if (ageMs >= searchTimeoutSeconds * 1000) {
        return expireBooking(bookingId);
      }

      // V5.8.2: một booking chỉ được có MỘT offer SENT tại một thời điểm.
      const activeOffer = await db.collection('driver_offers').findOne({
        bookingId,
        status: 'SENT',
        expiresAt: { $gt: new Date() },
      });

      if (activeOffer) {
        await scheduleOfferTimeout(
          bookingId,
          activeOffer.driverId,
          activeOffer.expiresAt,
        );
        return activeOffer;
      }

      const staleSentOffers = await db.collection('driver_offers').find({
        bookingId,
        status: 'SENT',
        expiresAt: { $lte: new Date() },
      }).toArray();

      if (staleSentOffers.length > 0) {
        const changedAt = new Date();
        await db.collection('driver_offers').updateMany(
          {
            bookingId,
            status: 'SENT',
            expiresAt: { $lte: changedAt },
          },
          {
            $set: {
              status: 'EXPIRED',
              respondedAt: changedAt,
              updatedAt: changedAt,
            },
          },
        );

        for (const stale of staleSentOffers) {
          await releaseOfferLock(stale.driverId, bookingId);
        }
      }

      const priorOffers = await db.collection('driver_offers').find({ bookingId })
        .project({ driverId: 1, status: 1 }).toArray();

      const excludedDriverIds = new Set(
        priorOffers
          .filter((item) =>
            ['REJECTED', 'EXPIRED', 'CANCELLED'].includes(item.status),
          )
          .map((item) => String(item.driverId)),
      );

      let candidates = await findGpsCandidates(booking, excludedDriverIds, policy);
      if (candidates.length === 0) {
        candidates = await findNoGpsFallbackCandidates(booking, excludedDriverIds, policy);
      }
      candidates = await rankMatchingCandidates({ db, candidates, policy });

      const attemptNo = priorOffers.length + 1;

      // candidates đã theo ưu tiên GPS/rating; chỉ gửi cho tài xế đầu tiên
      // khóa được. Không broadcast cùng booking cho toàn bộ tài xế.
      for (const candidate of candidates) {
        if (candidate.pointsBlocked) continue;
        const driverId = candidate.driver._id;
        if (await hasActiveBooking(driverId)) continue;

        const sentAt = new Date();
        const expiresAt = new Date(
          sentAt.getTime() + policy.offerTimeoutSeconds * 1000,
        );

        const locked = await acquireOfferLock(
          driverId,
          bookingId,
          expiresAt,
        );

        if (!locked) continue;

        try {
          const offerDoc = {
            bookingId,
            driverId,
            distanceToPickupKm: candidate.distanceKm,
            status: 'SENT',
            sentAt,
            respondedAt: null,
            expiresAt,
            matchingSource: candidate.source,
            matchingScore: candidate.matchingScore ?? null,
            matchingRank: candidate.matchingRank ?? null,
            matchingBreakdown: candidate.matchingBreakdown || null,
            matchingStrategy: policy.strategy,
            policyVersion: policy.version,
            attemptNo,
            updatedAt: sentAt,
          };

          try {
            await db.collection('driver_offers').updateOne(
              { bookingId, driverId },
              {
                $set: offerDoc,
                $setOnInsert: { createdAt: sentAt },
              },
              { upsert: true },
            );
          } catch (error) {
            if (error?.code === 11000) {
              await releaseOfferLock(driverId, bookingId);

              const winner = await db.collection('driver_offers').findOne({
                bookingId,
                status: 'SENT',
                expiresAt: { $gt: new Date() },
              });

              if (winner) {
                await scheduleOfferTimeout(
                  bookingId,
                  winner.driverId,
                  winner.expiresAt,
                );
                return winner;
              }

              continue;
            }
            throw error;
          }

          await db.collection('bookings').updateOne(
            { _id: bookingId, status: 'SEARCHING' },
            {
              $set: {
                dispatch: {
                  status: 'OFFER_SENT',
                  mode: 'SEQUENTIAL_SINGLE_DRIVER',
                  currentDriverId: driverId,
                  attemptNo,
                  offerSentAt: sentAt,
                  offerExpiresAt: expiresAt,
                  matchingSource: candidate.source,
                  distanceToPickupKm: candidate.distanceKm,
                  matchingScore: candidate.matchingScore ?? null,
                  matchingRank: candidate.matchingRank ?? null,
                  matchingStrategy: policy.strategy,
                  policyVersion: policy.version,
                  updatedAt: sentAt,
                },
                updatedAt: sentAt,
              },
            },
          );

          await addEvent(
            bookingId,
            'DRIVER_OFFER_SENT',
            'SYSTEM',
            driverId,
            {
              attemptNo,
              distanceToPickupKm: candidate.distanceKm,
              matchingSource: candidate.source,
              offerTimeoutSeconds: policy.offerTimeoutSeconds,
              dispatchMode: 'SEQUENTIAL_SINGLE_DRIVER',
              matchingScore: candidate.matchingScore ?? null,
              matchingRank: candidate.matchingRank ?? null,
              matchingBreakdown: candidate.matchingBreakdown || null,
              matchingStrategy: policy.strategy,
              policyVersion: policy.version,
            },
          );

          const freshBooking = await db.collection('bookings').findOne({
            _id: bookingId,
          });

          const payload = serializeBooking(freshBooking || booking);
          payload.offer = {
            attemptNo,
            expiresAt: expiresAt.toISOString(),
            secondsRemaining: policy.offerTimeoutSeconds,
            distanceToPickupKm: candidate.distanceKm,
            matchingSource: candidate.source,
            matchingScore: candidate.matchingScore ?? null,
            matchingRank: candidate.matchingRank ?? null,
            matchingStrategy: policy.strategy,
          };

          emitToDriver(driverId, 'driver:offer', payload);

          io?.to(roomUser(booking.customerId)).emit(
            'booking:matching',
            {
              bookingId: String(bookingId),
              status: 'SEARCHING',
              mode: 'SEQUENTIAL_SINGLE_DRIVER',
              attemptNo,
            },
          );

          await scheduleOfferTimeout(
            bookingId,
            driverId,
            expiresAt,
          );

          return offerDoc;
        } catch (error) {
          await releaseOfferLock(driverId, bookingId);
          throw error;
        }
      }

      const retryAt = new Date(
        Date.now() + policy.searchRetrySeconds * 1000,
      );

      await db.collection('bookings').updateOne(
        { _id: bookingId, status: 'SEARCHING' },
        {
          $set: {
            dispatch: {
              status: 'WAITING_DRIVER',
              mode: 'SEQUENTIAL_SINGLE_DRIVER',
              nextRetryAt: retryAt,
              updatedAt: new Date(),
            },
            updatedAt: new Date(),
          },
        },
      );

      setTimer(
        bookingId,
        policy.searchRetrySeconds * 1000,
        () => dispatchBooking(bookingId, { force: true }),
      );

      return null;
    } finally {
      await releaseDispatchLock(bookingId, lockToken);
    }
  }

  async function previewCandidates(rawBookingId, { includeNoGps = true } = {}) {
    const db = getDb();
    if (!db) throw new Error('MongoDB Atlas chưa sẵn sàng.');
    const bookingId = rawBookingId instanceof ObjectId ? rawBookingId : safeObjectId(rawBookingId);
    if (!bookingId) throw new Error('Booking id không hợp lệ.');
    const booking = await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking) throw new Error('Không tìm thấy chuyến.');

    const policy = await getMatchingPolicy();
    const emptyExcluded = new Set();
    let candidates = await findGpsCandidates(booking, emptyExcluded, policy);
    const gpsIds = new Set(candidates.map((item) => String(item.driver?._id)));

    if (includeNoGps) {
      const noGpsPolicy = { ...policy, allowNoGpsFallback: true };
      const noGps = await findNoGpsFallbackCandidates(booking, emptyExcluded, noGpsPolicy);
      for (const item of noGps) {
        if (gpsIds.has(String(item.driver?._id))) continue;
        candidates.push({ ...item, source: 'NO_GPS_ADMIN' });
      }
    }

    candidates = await rankMatchingCandidates({ db, candidates, policy });
    const priorOffers = await db.collection('driver_offers').find({ bookingId })
      .project({ driverId: 1, status: 1, sentAt: 1, respondedAt: 1 }).toArray();
    const priorByDriver = new Map(priorOffers.map((item) => [String(item.driverId), item]));

    return {
      booking: {
        id: String(booking._id),
        code: booking.bookingCode || String(booking._id),
        status: booking.status,
        pickup: booking.pickup?.address || booking.pickup?.addressText || '',
        destination: booking.destination?.address || booking.destination?.addressText || '',
      },
      policy,
      candidates: candidates.map((candidate) => {
        const prior = priorByDriver.get(String(candidate.driver?._id));
        return {
          driverId: String(candidate.driver?._id || ''),
          userId: candidate.user?._id ? String(candidate.user._id) : null,
          fullName: candidate.user?.fullName || candidate.user?.name || 'Tài xế',
          phone: candidate.user?.phone || '',
          plateNumber: candidate.vehicle?.plateNumber || '',
          vehicle: [candidate.vehicle?.brand, candidate.vehicle?.model].filter(Boolean).join(' '),
          onlineStatus: candidate.driver?.onlineStatus || 'OFFLINE',
          rating: Number(candidate.driver?.rating || 0),
          acceptanceRate: Number(candidate.driver?.acceptanceRate || 0),
          completedTrips: Number(candidate.driver?.completedTrips || 0),
          recentTrips: Number(candidate.recentTrips || 0),
          driverPoints: Number(candidate.driverPoints || 0),
          pointBalance: Number(candidate.pointBalance || 0),
          pointsBlocked: Boolean(candidate.pointsBlocked),
          pointsLow: Boolean(candidate.pointsLow),
          pointStatus: candidate.pointStatus || 'OK',
          pointWarning: candidate.pointWarning || null,
          distanceKm: Number.isFinite(Number(candidate.distanceKm)) ? Number(candidate.distanceKm) : null,
          source: candidate.source,
          score: Number(candidate.matchingScore || 0),
          rank: Number(candidate.matchingRank || 0),
          breakdown: candidate.matchingBreakdown || {},
          manualBoost: Number(candidate.matchingManualBoost || 0),
          priority: Number(candidate.matchingPriority || 0),
          priorOffer: prior ? {
            status: prior.status,
            sentAt: prior.sentAt || null,
            respondedAt: prior.respondedAt || null,
          } : null,
        };
      }),
    };
  }

  async function cancelActiveOffersForBooking(rawBookingId, reason = 'ADMIN_CANCELLED_OFFER', adminId = null) {
    const db = getDb();
    if (!db) throw new Error('MongoDB Atlas chưa sẵn sàng.');
    const bookingId = rawBookingId instanceof ObjectId ? rawBookingId : safeObjectId(rawBookingId);
    if (!bookingId) throw new Error('Booking id không hợp lệ.');
    const changedAt = new Date();
    const sentOffers = await db.collection('driver_offers').find({ bookingId, status: 'SENT' }).toArray();
    if (sentOffers.length) {
      await db.collection('driver_offers').updateMany(
        { bookingId, status: 'SENT' },
        { $set: { status: 'CANCELLED', reason, respondedAt: changedAt, updatedAt: changedAt } },
      );
      for (const offer of sentOffers) {
        await releaseOfferLock(offer.driverId, bookingId);
        emitToDriver(offer.driverId, 'driver:offer_closed', {
          bookingId: String(bookingId),
          status: 'CANCELLED',
          reason,
        });
      }
    }
    clearTimer(bookingId);
    if (sentOffers.length) {
      await addEvent(bookingId, 'ADMIN_OFFER_CANCELLED', 'ADMIN', adminId, {
        reason,
        cancelledOffers: sentOffers.length,
      });
    }
    return { bookingId: String(bookingId), cancelledOffers: sentOffers.length };
  }

  async function manualDispatchToDriver(rawBookingId, rawDriverId, { adminId = null, reason = '' } = {}) {
    const db = getDb();
    if (!db) throw new Error('MongoDB Atlas chưa sẵn sàng.');
    const bookingId = rawBookingId instanceof ObjectId ? rawBookingId : safeObjectId(rawBookingId);
    const driverId = rawDriverId instanceof ObjectId ? rawDriverId : safeObjectId(rawDriverId);
    if (!bookingId || !driverId) throw new Error('Booking hoặc Driver id không hợp lệ.');

    const booking = await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking) throw new Error('Không tìm thấy chuyến.');
    if (booking.status !== 'SEARCHING') throw new Error(`Chỉ phát đơn thủ công cho chuyến SEARCHING. Hiện tại: ${booking.status}`);

    const context = await getDriverContextById(driverId, booking?.serviceCode || 'BIKE');
    if (!context?.vehicle || !driverCanServe(context.vehicle, booking?.serviceCode || 'BIKE')) throw new Error('Tài xế không có phương tiện phù hợp với loại dịch vụ của chuyến.');
    if (context.driver.approvalStatus !== 'APPROVED' || context.driver.kycStatus !== 'APPROVED') {
      throw new Error('Tài xế chưa đủ điều kiện KYC/duyệt.');
    }
    if (context.driver.onlineStatus !== 'ONLINE') throw new Error('Tài xế phải ONLINE để nhận đơn.');
    if (await hasActiveBooking(driverId)) throw new Error('Tài xế đang có chuyến khác.');

    const policy = await getMatchingPolicy();
    const pointAccount = await db.collection('driver_reward_accounts').findOne({ driverId });
    const pointBalance = Number(pointAccount?.balance || 0);
    if (pointBalance < Number(policy.pointsPolicy?.blockBelow ?? 0)) {
      const error = new Error(`Tài xế đang âm điểm (${pointBalance}). Cần nạp điểm trước khi nhận cuốc.`);
      error.code = 'DRIVER_POINTS_BLOCKED';
      throw error;
    }
    const preview = await previewCandidates(bookingId, { includeNoGps: true });
    let candidate = preview.candidates.find((item) => item.driverId === String(driverId));
    if (!candidate) {
      candidate = {
        driverId: String(driverId), fullName: context.user?.fullName || 'Tài xế', phone: context.user?.phone || '',
        distanceKm: null, source: 'ADMIN_MANUAL', score: 0, rank: null, breakdown: {},
      };
    }

    await cancelActiveOffersForBooking(bookingId, 'ADMIN_REDISPATCH', adminId);

    const attemptNo = await db.collection('driver_offers').countDocuments({ bookingId }) + 1;
    const sentAt = new Date();
    const expiresAt = new Date(sentAt.getTime() + policy.offerTimeoutSeconds * 1000);
    const locked = await acquireOfferLock(driverId, bookingId, expiresAt);
    if (!locked) throw new Error('Không thể khóa tài xế để phát đơn. Tài xế có thể đang nhận offer khác.');

    try {
      const offerDoc = {
        bookingId,
        driverId,
        distanceToPickupKm: candidate.distanceKm,
        status: 'SENT',
        sentAt,
        respondedAt: null,
        expiresAt,
        matchingSource: 'ADMIN_MANUAL',
        matchingScore: candidate.score ?? null,
        matchingRank: candidate.rank ?? null,
        matchingBreakdown: candidate.breakdown || null,
        matchingStrategy: policy.strategy,
        policyVersion: policy.version,
        dispatchMode: 'MANUAL_ADMIN',
        adminId: adminId || null,
        adminReason: String(reason || '').trim() || null,
        attemptNo,
        updatedAt: sentAt,
      };

      await db.collection('driver_offers').updateOne(
        { bookingId, driverId },
        { $set: offerDoc, $setOnInsert: { createdAt: sentAt } },
        { upsert: true },
      );

      await db.collection('bookings').updateOne(
        { _id: bookingId, status: 'SEARCHING' },
        {
          $set: {
            dispatch: {
              status: 'OFFER_SENT',
              mode: 'MANUAL_ADMIN',
              currentDriverId: driverId,
              attemptNo,
              offerSentAt: sentAt,
              offerExpiresAt: expiresAt,
              matchingSource: 'ADMIN_MANUAL',
              distanceToPickupKm: candidate.distanceKm,
              matchingScore: candidate.score ?? null,
              matchingRank: candidate.rank ?? null,
              matchingStrategy: policy.strategy,
              policyVersion: policy.version,
              adminId: adminId || null,
              adminReason: String(reason || '').trim() || null,
              updatedAt: sentAt,
            },
            updatedAt: sentAt,
          },
        },
      );

      await addEvent(bookingId, 'ADMIN_DRIVER_OFFER_SENT', 'ADMIN', adminId, {
        driverId: String(driverId),
        reason: String(reason || '').trim() || null,
        score: candidate.score ?? null,
        rank: candidate.rank ?? null,
        strategy: policy.strategy,
      });

      const freshBooking = await db.collection('bookings').findOne({ _id: bookingId });
      const payload = serializeBooking(freshBooking || booking);
      payload.offer = {
        attemptNo,
        expiresAt: expiresAt.toISOString(),
        secondsRemaining: policy.offerTimeoutSeconds,
        distanceToPickupKm: candidate.distanceKm,
        matchingSource: 'ADMIN_MANUAL',
        matchingScore: candidate.score ?? null,
        matchingRank: candidate.rank ?? null,
        matchingStrategy: policy.strategy,
      };
      emitToDriver(driverId, 'driver:offer', payload);
      io?.to(roomUser(booking.customerId)).emit('booking:matching', {
        bookingId: String(bookingId),
        status: 'SEARCHING',
        mode: 'MANUAL_ADMIN',
        attemptNo,
      });
      await scheduleOfferTimeout(bookingId, driverId, expiresAt);
      return offerDoc;
    } catch (error) {
      await releaseOfferLock(driverId, bookingId);
      throw error;
    }
  }

  async function adminRedispatch(rawBookingId, { adminId = null, reason = '' } = {}) {
    const bookingId = rawBookingId instanceof ObjectId ? rawBookingId : safeObjectId(rawBookingId);
    if (!bookingId) throw new Error('Booking id không hợp lệ.');
    await cancelActiveOffersForBooking(bookingId, 'ADMIN_REDISPATCH', adminId);
    await addEvent(bookingId, 'ADMIN_REDISPATCH_REQUESTED', 'ADMIN', adminId, { reason: String(reason || '').trim() || null });
    return dispatchBooking(bookingId, { force: true, manual: true });
  }

  async function getAvailableOffers(driverId) {
    const db = getDb();
    if (!db) return [];
    const nowDate = new Date();

    const expired = await db.collection('driver_offers').find({
      driverId,
      status: 'SENT',
      expiresAt: { $lte: nowDate },
    }).toArray();

    for (const offer of expired) {
      await expireOfferAndDispatchNext(offer.bookingId, offer.driverId);
    }

    const offer = await db.collection('driver_offers').findOne(
      {
        driverId,
        status: 'SENT',
        expiresAt: { $gt: new Date() },
      },
      { sort: { sentAt: -1 } },
    );

    if (!offer) return [];

    const booking = await db.collection('bookings').findOne({
      _id: offer.bookingId,
      status: 'SEARCHING',
      'dispatch.currentDriverId': driverId,
    });

    if (!booking) return [];

    const payload = serializeBooking(booking);
    payload.offer = {
      attemptNo: offer.attemptNo || booking.dispatch?.attemptNo || 1,
      expiresAt: offer.expiresAt?.toISOString?.()
        || new Date(offer.expiresAt).toISOString(),
      secondsRemaining: Math.max(
        0,
        Math.ceil(
          (new Date(offer.expiresAt).getTime() - Date.now()) / 1000,
        ),
      ),
      distanceToPickupKm: offer.distanceToPickupKm ?? null,
      matchingSource: offer.matchingSource || null,
    };

    return [payload];
  }

  async function declineOffer(bookingId, driverId, reason) {
    const db = getDb();
    const changedAt = new Date();
    const offer = await db.collection('driver_offers').findOne({
      bookingId,
      driverId,
      status: 'SENT',
    });
    if (!offer) {
      const error = new Error('Cuốc này không còn được gửi cho tài xế hoặc đã hết thời gian nhận.');
      error.code = 'OFFER_NOT_ACTIVE';
      throw error;
    }

    await db.collection('driver_offers').updateOne(
      { _id: offer._id, status: 'SENT' },
      {
        $set: {
          status: 'REJECTED',
          respondedAt: changedAt,
          reason: reason || 'DRIVER_NOT_INTERESTED',
          updatedAt: changedAt,
        },
      },
    );
    await releaseOfferLock(driverId, bookingId);
    await addEvent(bookingId, 'DRIVER_DECLINED', 'DRIVER', driverId, {
      reason: reason || 'DRIVER_NOT_INTERESTED',
    });
    emitToDriver(driverId, 'driver:offer_closed', {
      bookingId: String(bookingId),
      status: 'REJECTED',
    });
    clearTimer(bookingId);
    setImmediate(() => {
      dispatchBooking(bookingId, { force: true }).catch((error) => {
        console.error('[Matching] Dispatch after decline failed:', error.message);
      });
    });
    return { ok: true };
  }

  async function validateActiveOffer(bookingId, driverId) {
    if (!config.strictAccept) return { ok: true };
    const db = getDb();
    const offer = await db.collection('driver_offers').findOne({
      bookingId,
      driverId,
      status: 'SENT',
      expiresAt: { $gt: new Date() },
    });
    if (!offer) {
      return { ok: false, message: 'Cuốc không còn được gửi cho tài xế này hoặc đã hết thời gian nhận.' };
    }
    if (await hasActiveBooking(driverId, bookingId)) {
      return { ok: false, message: 'Tài xế đang có một chuyến khác.' };
    }
    const driver = await db.collection('drivers').findOne({ _id: driverId });
    if (!driver || driver.onlineStatus !== 'ONLINE') {
      return { ok: false, message: 'Tài xế không còn ở trạng thái ONLINE.' };
    }
    const policy = await getMatchingPolicy();
    const pointAccount = await db.collection('driver_reward_accounts').findOne({ driverId });
    const pointBalance = Number(pointAccount?.balance || 0);
    if (pointBalance < Number(policy.pointsPolicy?.blockBelow ?? 0)) {
      return {
        ok: false,
        code: 'DRIVER_POINTS_BLOCKED',
        message: `Tài xế đang âm điểm (${pointBalance}). Vui lòng nạp thêm điểm trước khi nhận cuốc.`,
      };
    }
    if (String(driver.currentOfferBookingId || '') !== String(bookingId)) {
      return { ok: false, message: 'Cuốc đã được chuyển sang tài xế khác.' };
    }
    return { ok: true, offer, pointBalance };
  }

  async function claimDriverForBooking(driverId, bookingId) {
    const db = getDb();
    const changedAt = new Date();
    const result = await db.collection('drivers').updateOne(
      {
        _id: driverId,
        approvalStatus: 'APPROVED',
        kycStatus: 'APPROVED',
        onlineStatus: 'ONLINE',
        currentOfferBookingId: bookingId,
        currentOfferExpiresAt: { $gt: changedAt },
      },
      {
        $set: {
          onlineStatus: 'BUSY',
          activeBookingId: bookingId,
          currentOfferBookingId: null,
          currentOfferExpiresAt: null,
          updatedAt: changedAt,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async function rollbackDriverClaim(driverId, bookingId) {
    const db = getDb();
    if (!db) return;
    await db.collection('drivers').updateOne(
      { _id: driverId, activeBookingId: bookingId, onlineStatus: 'BUSY' },
      {
        $set: {
          onlineStatus: 'ONLINE',
          activeBookingId: null,
          updatedAt: new Date(),
        },
      },
    );
  }

  async function onBookingAccepted(booking, driverId) {
    const db = getDb();
    if (!db || !booking) return;
    const changedAt = new Date();
    clearTimer(booking._id);
    await db.collection('driver_offers').updateOne(
      { bookingId: booking._id, driverId, status: 'SENT' },
      { $set: { status: 'ACCEPTED', respondedAt: changedAt, updatedAt: changedAt } },
    );
    await db.collection('driver_offers').updateMany(
      { bookingId: booking._id, driverId: { $ne: driverId }, status: 'SENT' },
      { $set: { status: 'CANCELLED', respondedAt: changedAt, updatedAt: changedAt } },
    );
    emitToDriver(driverId, 'driver:offer_closed', {
      bookingId: String(booking._id),
      status: 'ACCEPTED',
    });
    emitBookingUpdate(booking);
  }

  async function requeueAfterDriverCancel(booking, driverId, reason) {
    const db = getDb();
    if (!db || !booking || !driverId) {
      const error = new Error('Không thể đưa chuyến về hàng chờ matching.');
      error.code = 'REQUEUE_FAILED';
      throw error;
    }

    if (!['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED'].includes(booking.status)) {
      const error = new Error(
        'Chỉ có thể chuyển sang tài xế khác trước khi chuyến bắt đầu.',
      );
      error.code = 'REQUEUE_NOT_ALLOWED';
      throw error;
    }

    if (String(booking.driverId || '') !== String(driverId)) {
      const error = new Error('Tài xế không còn được gán cho chuyến này.');
      error.code = 'DRIVER_NOT_ASSIGNED';
      throw error;
    }

    const changedAt = new Date();
    clearTimer(booking._id);

    await db.collection('driver_offers').updateMany(
      {
        bookingId: booking._id,
        driverId,
        status: { $in: ['SENT', 'ACCEPTED'] },
      },
      {
        $set: {
          status: 'CANCELLED',
          reason: reason || 'DRIVER_CANCELLED_AFTER_ACCEPT',
          respondedAt: changedAt,
          updatedAt: changedAt,
        },
      },
    );

    await releaseOfferLock(driverId, booking._id);

    await db.collection('drivers').updateOne(
      { _id: driverId, activeBookingId: booking._id },
      {
        $set: {
          onlineStatus: 'ONLINE',
          activeBookingId: null,
          currentOfferBookingId: null,
          currentOfferExpiresAt: null,
          updatedAt: changedAt,
        },
      },
    );

    const result = await db.collection('bookings').findOneAndUpdate(
      {
        _id: booking._id,
        driverId,
        status: booking.status,
      },
      {
        $set: {
          status: 'SEARCHING',
          driverId: null,
          vehicleId: null,
          driverSnapshot: null,
          assignedAt: null,
          driverDepartedAt: null,
          driverArrivedAt: null,
          cancellation: null,
          cancelledAt: null,
          updatedAt: changedAt,
          dispatch: {
            status: 'REQUEUED_AFTER_DRIVER_CANCEL',
            mode: 'SEQUENTIAL_SINGLE_DRIVER',
            previousDriverId: driverId,
            requeuedAt: changedAt,
            reason: reason || 'DRIVER_CANCELLED_AFTER_ACCEPT',
            updatedAt: changedAt,
          },
        },
        $push: {
          driverCancellationHistory: {
            driverId,
            reason: reason || 'DRIVER_CANCELLED_AFTER_ACCEPT',
            previousStatus: booking.status,
            cancelledAt: changedAt,
          },
        },
      },
      { returnDocument: 'after' },
    );

    const requeued = normalizeFindOneAndUpdate(result);
    if (!requeued) {
      const error = new Error(
        'Trạng thái chuyến đã thay đổi, không thể matching lại.',
      );
      error.code = 'REQUEUE_RACE';
      throw error;
    }

    await addEvent(
      booking._id,
      'DRIVER_CANCELLED_REASSIGN',
      'DRIVER',
      driverId,
      {
        reason: reason || 'DRIVER_CANCELLED_AFTER_ACCEPT',
        previousStatus: booking.status,
        status: 'SEARCHING',
      },
    );

    emitToDriver(driverId, 'driver:trip_released', {
      bookingId: String(booking._id),
      status: 'SEARCHING',
      reason: reason || 'DRIVER_CANCELLED_AFTER_ACCEPT',
      message: 'Đã trả chuyến về hệ thống để tìm tài xế khác.',
    });

    emitBookingUpdate(requeued);

    io?.to(roomUser(requeued.customerId)).emit(
      'booking:matching',
      {
        bookingId: String(requeued._id),
        status: 'SEARCHING',
        reason: 'DRIVER_CANCELLED_REASSIGN',
        mode: 'SEQUENTIAL_SINGLE_DRIVER',
      },
    );

    setImmediate(() => {
      dispatchBooking(requeued._id, { force: true }).catch((error) => {
        console.error(
          '[Matching] Dispatch after driver cancel failed:',
          error.message,
        );
      });
    });

    return requeued;
  }

  async function onBookingTerminal(booking) {
    const db = getDb();
    if (!db || !booking) return;
    clearTimer(booking._id);
    const changedAt = new Date();

    const sentOffers = await db.collection('driver_offers').find({
      bookingId: booking._id,
      status: 'SENT',
    }).toArray();

    await db.collection('driver_offers').updateMany(
      { bookingId: booking._id, status: 'SENT' },
      { $set: { status: 'CANCELLED', respondedAt: changedAt, updatedAt: changedAt } },
    );

    for (const offer of sentOffers) {
      await releaseOfferLock(offer.driverId, booking._id);
      emitToDriver(offer.driverId, 'driver:offer_closed', {
        bookingId: String(booking._id),
        status: booking.status,
      });
    }

    if (booking.driverId) {
      await db.collection('drivers').updateOne(
        { _id: booking.driverId, activeBookingId: booking._id },
        {
          $set: {
            activeBookingId: null,
            currentOfferBookingId: null,
            currentOfferExpiresAt: null,
            updatedAt: changedAt,
          },
        },
      );
    }

    emitBookingUpdate(booking);
  }

  async function onDriverOffline(driverId) {
    const db = getDb();
    if (!db || !driverId) return;
    const driver = await db.collection('drivers').findOne({ _id: driverId });
    await db.collection('driver_locations').deleteOne({ driverId });

    const bookingId = driver?.currentOfferBookingId || null;
    if (bookingId) {
      await db.collection('driver_offers').updateOne(
        { bookingId, driverId, status: 'SENT' },
        {
          $set: {
            status: 'CANCELLED',
            respondedAt: new Date(),
            reason: 'DRIVER_OFFLINE',
            updatedAt: new Date(),
          },
        },
      );
      await releaseOfferLock(driverId, bookingId);
      clearTimer(bookingId);
      setImmediate(() => {
        dispatchBooking(bookingId, { force: true }).catch((error) => {
          console.error('[Matching] Dispatch after offline failed:', error.message);
        });
      });
    }
  }

  async function driverCanGoOnline(driverId) {
    if (await hasActiveBooking(driverId)) {
      return { ok: false, message: 'Tài xế đang có chuyến hoạt động.' };
    }
    return { ok: true };
  }

  async function resumeSearchingBookings() {
    const db = getDb();
    if (!db || !config.enabled) return;
    const bookings = await db.collection('bookings').find({ status: 'SEARCHING' })
      .sort({ createdAt: 1 }).limit(200).toArray();
    for (const booking of bookings) {
      dispatchBooking(booking._id).catch((error) => {
        console.error('[Matching] Resume booking failed:', error.message);
      });
    }
  }

  async function sweepExpiredOffers() {
    const db = getDb();
    if (!db) return;
    const expired = await db.collection('driver_offers').find({
      status: 'SENT',
      expiresAt: { $lte: new Date() },
    }).limit(100).toArray();
    for (const offer of expired) {
      await expireOfferAndDispatchNext(offer.bookingId, offer.driverId);
    }
  }

  async function databaseReady() {
    await ensureIndexes();
    const db = getDb();
    const policy = await getMatchingPolicy({ refresh: true });
    await db.collection('dispatch_configs').updateOne(
      { key: 'BIKE_V69_DISPATCH' },
      {
        $set: {
          enabled: policy.autoDispatchEnabled,
          updatedAt: new Date(),
          source: 'MATCHING_STARTUP_SYNC',
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    await resumeSearchingBookings();
    if (!sweeping) {
      sweeping = setInterval(() => {
        sweepExpiredOffers().catch((error) => {
          console.error('[Matching] Sweep failed:', error.message);
        });
      }, 5000);
      sweeping.unref?.();
    }
  }

  async function authenticateSocket(socket, next) {
    try {
      const secret = String(process.env.JWT_ACCESS_SECRET || '').trim();
      if (secret.length < 32) throw new Error('JWT_ACCESS_SECRET chưa cấu hình an toàn.');

      const authToken = String(socket.handshake.auth?.token || '').trim();
      const header = String(socket.handshake.headers?.authorization || '').trim();
      const token = authToken || (header.startsWith('Bearer ') ? header.slice(7).trim() : '');
      if (!token) return next(new Error('UNAUTHORIZED'));

      const payload = jwt.verify(token, secret, {
        issuer: 'th79-imove',
        audience: 'th79-imove-apps',
      });
      const userId = safeObjectId(payload.sub);
      if (!userId) return next(new Error('UNAUTHORIZED'));

      const db = getDb();
      if (!db) return next(new Error('DATABASE_UNAVAILABLE'));
      const user = await db.collection('users').findOne({ _id: userId, status: 'ACTIVE' });
      if (!user) return next(new Error('UNAUTHORIZED'));

      let driver = null;
      if (Array.isArray(user.roles) && user.roles.includes('DRIVER')) {
        driver = await db.collection('drivers').findOne({ userId: user._id });
      }

      socket.data.user = user;
      socket.data.driver = driver;
      return next();
    } catch (_) {
      return next(new Error('UNAUTHORIZED'));
    }
  }

  function installSocketServer() {
    if (!server || io) return;
    io = new SocketIOServer(server, {
      cors: {
        origin: true,
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      path: '/socket.io',
      pingInterval: 25000,
      pingTimeout: 20000,
    });

    io.use(authenticateSocket);

    io.on('connection', (socket) => {
      const user = socket.data.user;
      const driver = socket.data.driver;
      socket.join(roomUser(user._id));
      if (driver) socket.join(roomDriver(driver._id));

      socket.on('booking:subscribe', async (payload, ack) => {
        try {
          const db = getDb();
          const bookingId = safeObjectId(payload?.bookingId);
          if (!db || !bookingId) throw new Error('Booking id không hợp lệ.');
          const booking = await db.collection('bookings').findOne({ _id: bookingId });
          if (!booking) throw new Error('Không tìm thấy chuyến.');

          const isCustomer = String(booking.customerId) === String(user._id);
          const isDriver = driver && booking.driverId && String(booking.driverId) === String(driver._id);
          if (!isCustomer && !isDriver) throw new Error('Không có quyền theo dõi chuyến này.');

          socket.join(roomBooking(bookingId));
          ack?.({ ok: true, booking: serializeBooking(booking) });
        } catch (error) {
          ack?.({ ok: false, message: error.message });
        }
      });

      socket.on('driver:location', async (payload, ack) => {
        try {
          if (!driver) throw new Error('Socket này không thuộc tài xế.');
          const result = await updateLocationByDriverId(driver._id, user._id, payload);
          ack?.(result);
        } catch (error) {
          ack?.({ ok: false, code: error.code || null, message: error.message });
        }
      });
    });
  }

  function getPublicConfig() {
    return {
      enabled: config.enabled,
      offerTimeoutSeconds: config.offerTimeoutSeconds,
      searchRetrySeconds: config.searchRetrySeconds,
      maxRadiusKm: config.maxRadiusKm,
      locationFreshSeconds: config.locationFreshSeconds,
      locationTtlSeconds: config.locationTtlSeconds,
      allowNoGpsFallback: config.allowNoGpsFallback,
      strictAccept: config.strictAccept,
      singleOfferPerBooking: config.singleOfferPerBooking,
      dispatchMode: 'SEQUENTIAL_SINGLE_DRIVER',
      dynamicPolicy: true,
      realtime: Boolean(io),
      socketPath: '/socket.io',
    };
  }

  async function stats() {
    const db = getDb();
    if (!db) return { database: false };
    const nowDate = new Date();
    const policy = await getMatchingPolicy();
    const blockBelow = Number(policy.pointsPolicy?.blockBelow ?? 0);
    const warnBelow = Number(policy.pointsPolicy?.warnBelow ?? 20);
    const [
      onlineDrivers,
      freshLocations,
      searchingBookings,
      sentOffers,
      duplicateActiveOfferGroups,
      negativePointDrivers,
      lowPointDrivers,
    ] = await Promise.all([
      db.collection('drivers').countDocuments({
        approvalStatus: 'APPROVED',
        kycStatus: 'APPROVED',
        onlineStatus: 'ONLINE',
      }),
      db.collection('driver_locations').countDocuments({
        updatedAt: { $gte: new Date(Date.now() - config.locationFreshSeconds * 1000) },
      }),
      db.collection('bookings').countDocuments({ status: 'SEARCHING' }),
      db.collection('driver_offers').countDocuments({
        status: 'SENT',
        expiresAt: { $gt: nowDate },
      }),
      db.collection('driver_offers').aggregate([
        {
          $match: {
            status: 'SENT',
            expiresAt: { $gt: nowDate },
          },
        },
        {
          $group: {
            _id: '$bookingId',
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $count: 'count' },
      ]).toArray(),
      db.collection('driver_reward_accounts').countDocuments({ balance: { $lt: blockBelow } }),
      db.collection('driver_reward_accounts').countDocuments({ balance: { $gte: blockBelow, $lte: warnBelow } }),
    ]);
    return {
      database: true,
      onlineDrivers,
      freshLocations,
      searchingBookings,
      activeOffers: sentOffers,
      duplicateActiveOfferBookings: duplicateActiveOfferGroups[0]?.count || 0,
      negativePointDrivers,
      lowPointDrivers,
      dispatchMode: 'SEQUENTIAL_SINGLE_DRIVER',
    };
  }

  function start() {
    if (started) return;
    started = true;
    installSocketServer();
  }

  function close() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (sweeping) clearInterval(sweeping);
    sweeping = null;
    try { io?.close(); } catch (_) {}
    io = null;
  }

  return {
    start,
    close,
    databaseReady,
    getPublicConfig,
    stats,
    updateLocationByContext,
    dispatchBooking,
    getAvailableOffers,
    declineOffer,
    validateActiveOffer,
    claimDriverForBooking,
    rollbackDriverClaim,
    onBookingAccepted,
    requeueAfterDriverCancel,
    onBookingTerminal,
    emitBookingUpdate,
    emitToUser,
    serializeBookingPublic,
    onDriverOffline,
    driverCanGoOnline,
    hasActiveBooking,
    getMatchingPolicy,
    saveMatchingPolicy,
    invalidateMatchingPolicyCache,
    MATCHING_PRESETS,
    previewCandidates,
    manualDispatchToDriver,
    adminRedispatch,
    cancelActiveOffersForBooking,
    socketStats: () => ({ connections: io?.engine?.clientsCount || 0 }),
  };
}

module.exports = { createMatchingEngine };
