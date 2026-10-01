const crypto = require('crypto');
const { ObjectId } = require('mongodb');

function oid(v) { try { return v instanceof ObjectId ? v : new ObjectId(String(v)); } catch (_) { return null; } }

const DEFAULT_CONFIG = {
  key: 'BIKE_V69_DISPATCH',
  enabled: true,
  maxRounds: 4,
  rounds: [
    { round: 1, candidateCount: 3, radiusKm: 2, timeoutSeconds: 12 },
    { round: 2, candidateCount: 5, radiusKm: 4, timeoutSeconds: 15 },
    { round: 3, candidateCount: 8, radiusKm: 7, timeoutSeconds: 20 },
    { round: 4, candidateCount: 15, radiusKm: 10, timeoutSeconds: 25 },
  ],
  cooldown: { declineSeconds: 60, timeoutSeconds: 30, sameBookingSeconds: 600 },
  retry: { maxDispatchRetries: 3, retryDelaySeconds: [3, 10, 30] },
};

function normalizeConfig(raw = {}) {
  const rounds = Array.isArray(raw.rounds) && raw.rounds.length ? raw.rounds : DEFAULT_CONFIG.rounds;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    enabled: raw.enabled !== false,
    maxRounds: Math.max(1, Math.min(8, Number(raw.maxRounds || rounds.length || 4))),
    rounds: rounds.slice(0, 8).map((r, i) => ({
      round: i + 1,
      candidateCount: Math.max(1, Math.min(50, Number(r.candidateCount || 3))),
      radiusKm: Math.max(.5, Math.min(50, Number(r.radiusKm || 2))),
      timeoutSeconds: Math.max(5, Math.min(120, Number(r.timeoutSeconds || 15))),
    })),
    cooldown: {
      ...DEFAULT_CONFIG.cooldown,
      ...(raw.cooldown || {}),
    },
    retry: {
      ...DEFAULT_CONFIG.retry,
      ...(raw.retry || {}),
    },
  };
}

function createDispatchEngine({ getDb, getClient, getMatching, notificationService, serializeBooking, addEvent }) {
  let sweepTimer = null;
  let started = false;
  const retryTimers = new Map();
  const bookingSearchTimeoutSeconds = Math.max(60, Number(process.env.BOOKING_SEARCH_TIMEOUT_SECONDS || 300));

  function clearRetryTimer(bookingId) {
    const key = String(bookingId);
    const timer = retryTimers.get(key);
    if (timer) clearTimeout(timer);
    retryTimers.delete(key);
  }

  function scheduleRetry(bookingId, delaySeconds = 5, options = {}) {
    const key = String(bookingId);
    clearRetryTimer(bookingId);
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      dispatchWithRetry(bookingId, options).catch((e) => console.error('[V6.9 Dispatch scheduled retry]', e.message));
    }, Math.max(1, Number(delaySeconds || 5)) * 1000);
    timer.unref?.();
    retryTimers.set(key, timer);
  }

  async function databaseReady() {
    const db = getDb(); if (!db) return;
    await Promise.allSettled([
      db.collection('booking_offers_v69').createIndex({ bookingId: 1, driverId: 1, dispatchVersion: 1 }, { unique: true, name: 'uq_v69_offer_booking_driver_version' }),
      db.collection('booking_offers_v69').createIndex({ driverId: 1, status: 1, expiresAt: 1 }, { name: 'idx_v69_driver_active_offer' }),
      db.collection('dispatch_rounds_v69').createIndex({ bookingId: 1, dispatchVersion: 1, round: 1 }, { unique: true, name: 'uq_v69_dispatch_round' }),
      db.collection('dispatch_configs').createIndex({ key: 1 }, { unique: true, name: 'uq_dispatch_config' }),
      db.collection('driver_cooldowns').createIndex({ driverId: 1, expiresAt: 1 }, { name: 'idx_driver_cooldown_active' }),
      db.collection('driver_cooldowns').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_driver_cooldown' }),
      db.collection('dispatch_events').createIndex({ bookingId: 1, createdAt: 1 }, { name: 'idx_dispatch_events' }),
      db.collection('idempotency_keys').createIndex({ key: 1, userId: 1, endpoint: 1 }, { unique: true, name: 'uq_idempotency' }),
      db.collection('idempotency_keys').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_idempotency' }),
    ]);
    await db.collection('dispatch_configs').updateOne({ key: DEFAULT_CONFIG.key }, { $setOnInsert: { ...DEFAULT_CONFIG, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
  }

  async function getConfig() {
    const doc = await getDb().collection('dispatch_configs').findOne({ key: DEFAULT_CONFIG.key });
    return normalizeConfig(doc || DEFAULT_CONFIG);
  }

  async function saveConfig(raw, adminId = null) {
    const cfg = normalizeConfig(raw || {});
    await getDb().collection('dispatch_configs').updateOne({ key: DEFAULT_CONFIG.key }, { $set: { ...cfg, key: DEFAULT_CONFIG.key, updatedAt: new Date(), updatedBy: adminId } }, { upsert: true });
    return cfg;
  }

  async function event(bookingId, name, data = {}) {
    await getDb().collection('dispatch_events').insertOne({ bookingId, event: name, ...data, createdAt: new Date() });
  }

  async function eligibleCandidate(bookingId, candidate) {
    const db = getDb();
    const driverId = oid(candidate.driverId); if (!driverId) return false;
    const now = new Date();
    const cooldown = await db.collection('driver_cooldowns').findOne({
      driverId,
      expiresAt: { $gt: now },
      $or: [
        { type: { $ne: 'SAME_BOOKING' } },
        { type: 'SAME_BOOKING', bookingId },
      ],
    });
    if (cooldown) return false;
    const activeOffer = await db.collection('booking_offers_v69').findOne({ driverId, status: 'PENDING', expiresAt: { $gt: now } });
    if (activeOffer) return false;
    return true;
  }

  async function dispatchBooking(rawBookingId, { reset = false, adminId = null } = {}) {
    const db = getDb(); const bookingId = oid(rawBookingId); if (!bookingId) throw new Error('Booking id không hợp lệ.');
    let booking = await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking) throw new Error('Không tìm thấy booking.');
    if (booking.status === 'NO_DRIVER' && (reset || adminId)) {
      await db.collection('bookings').updateOne(
        { _id: bookingId, status: 'NO_DRIVER' },
        { $set: { status: 'SEARCHING', updatedAt: new Date(), 'dispatchEngine.status': 'REQUEUED' }, $unset: { 'dispatchEngine.completedAt': '' } },
      );
      booking = await db.collection('bookings').findOne({ _id: bookingId });
    }
    if (!['SEARCHING', 'OFFERED'].includes(booking.status)) return { skipped: true, status: booking.status };
    const cfg = await getConfig(); if (!cfg.enabled) return { skipped: true, reason: 'DISPATCH_DISABLED' };
    const bookingAgeMs = Date.now() - new Date(booking.createdAt || booking.requestedAt || Date.now()).getTime();
    if (bookingAgeMs >= bookingSearchTimeoutSeconds * 1000) {
      clearRetryTimer(bookingId);
      await db.collection('bookings').updateOne(
        { _id: bookingId, status: { $in: ['SEARCHING', 'OFFERED'] } },
        { $set: { status: 'NO_DRIVER', 'dispatchEngine.status': 'NO_DRIVER', 'dispatchEngine.completedAt': new Date(), updatedAt: new Date() } },
      );
      await event(bookingId, 'NO_DRIVER', { reason: 'SEARCH_TIMEOUT', bookingSearchTimeoutSeconds });
      return { noDriver: true, reason: 'SEARCH_TIMEOUT' };
    }
    let dispatchVersion = Number(booking?.dispatchEngine?.version || 0);
    let nextRound = Number(booking?.dispatchEngine?.currentRound || 0) + 1;
    if (reset || dispatchVersion === 0) { dispatchVersion += 1; nextRound = 1; }
    if (nextRound > cfg.maxRounds || nextRound > cfg.rounds.length) {
      const retryDelay = Math.max(3, Number(cfg.retry?.retryDelaySeconds?.[0] || 5));
      const nextRetryAt = new Date(Date.now() + retryDelay * 1000);
      await db.collection('bookings').updateOne(
        { _id: bookingId, status: { $in: ['SEARCHING', 'OFFERED'] } },
        { $set: { status: 'SEARCHING', 'dispatchEngine.version': dispatchVersion, 'dispatchEngine.currentRound': 0, 'dispatchEngine.status': 'WAITING_DRIVER', 'dispatchEngine.nextRetryAt': nextRetryAt, updatedAt: new Date() } },
      );
      await event(bookingId, 'DISPATCH_CYCLE_EMPTY', { round: nextRound - 1, dispatchVersion, nextRetryAt });
      scheduleRetry(bookingId, retryDelay, { reset: true, adminId });
      return { waitingDriver: true, nextRetryAt };
    }
    const roundCfg = cfg.rounds[nextRound - 1];
    const matchingPolicy = await getMatching().getMatchingPolicy();
    const preview = await getMatching().previewCandidates(bookingId, { includeNoGps: Boolean(matchingPolicy?.allowNoGpsFallback) });
    const previouslyOffered = new Set((await db.collection('booking_offers_v69').find({ bookingId, dispatchVersion }).project({ driverId: 1 }).toArray()).map(x => String(x.driverId)));
    const candidates = [];
    for (const c of preview.candidates || []) {
      if (c.pointsBlocked) continue;
      if (c.distanceKm != null && Number(c.distanceKm) > roundCfg.radiusKm) continue;
      if (previouslyOffered.has(String(c.driverId))) continue;
      if (!(await eligibleCandidate(bookingId, c))) continue;
      candidates.push(c);
      if (candidates.length >= roundCfg.candidateCount) break;
    }
    if (!candidates.length) {
      const delaySeconds = Math.max(2, Math.min(10, Number(cfg.retry?.retryDelaySeconds?.[0] || 3)));
      const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);
      await db.collection('bookings').updateOne(
        { _id: bookingId },
        { $set: { status: 'SEARCHING', 'dispatchEngine.version': dispatchVersion, 'dispatchEngine.currentRound': nextRound, 'dispatchEngine.status': 'WAITING_NEXT_ROUND', 'dispatchEngine.nextRetryAt': nextRetryAt, updatedAt: new Date() } },
      );
      await event(bookingId, 'ROUND_EMPTY', { round: nextRound, dispatchVersion, candidatePreviewCount: Number(preview?.candidates?.length || 0), nextRetryAt });
      scheduleRetry(bookingId, delaySeconds, { reset: false, adminId });
      return { waitingNextRound: true, round: nextRound, nextRetryAt };
    }
    clearRetryTimer(bookingId);
    const now = new Date(); const expiresAt = new Date(now.getTime() + roundCfg.timeoutSeconds * 1000);
    await db.collection('dispatch_rounds_v69').updateOne({ bookingId, dispatchVersion, round: nextRound }, { $setOnInsert: { bookingId, dispatchVersion, round: nextRound, radiusKm: roundCfg.radiusKm, requestedCandidates: roundCfg.candidateCount, actualCandidates: candidates.length, status: 'WAITING', startedAt: now, expiresAt, createdAt: now } }, { upsert: true });
    for (const c of candidates) {
      const driverId = oid(c.driverId); if (!driverId) continue;
      let offer;
      try {
        const result = await db.collection('booking_offers_v69').insertOne({ bookingId, bookingCode: booking.bookingCode, driverId, round: nextRound, rank: c.rank, matchingScore: c.score, matchingSnapshot: { distanceKm: c.distanceKm, rating: c.rating, acceptanceRate: c.acceptanceRate, completedTripsRecent: c.recentTrips, driverPoints: c.driverPoints, breakdown: c.breakdown || {} }, status: 'PENDING', offeredAt: now, expiresAt, respondedAt: null, dispatchVersion, notification: { socketSent: false, fcmQueued: false, fcmSent: false }, createdAt: now, updatedAt: now });
        offer = await db.collection('booking_offers_v69').findOne({ _id: result.insertedId });
      } catch (e) { if (e.code !== 11000) throw e; offer = await db.collection('booking_offers_v69').findOne({ bookingId, driverId, dispatchVersion }); }
      if (!offer) continue;
      const payload = serializeBooking(booking);
      getMatching().emitToDriver(driverId, 'v69:booking_offer', { offerId: String(offer._id), expiresAt: expiresAt.toISOString(), booking: payload, round: nextRound, matchingScore: c.score });
      await db.collection('booking_offers_v69').updateOne({ _id: offer._id }, { $set: { 'notification.socketSent': true, updatedAt: new Date() } });
      await notificationService.enqueue({ dedupeKey: `BOOKING_OFFER:${bookingId}:${driverId}:${dispatchVersion}`, type: 'BOOKING_OFFER', targetType: 'DRIVER', targetId: driverId, bookingId, offerId: offer._id, title: 'Có chuyến mới', body: c.distanceKm == null ? 'Có khách đang chờ bạn nhận chuyến.' : `Điểm đón cách bạn ${Number(c.distanceKm).toFixed(1)} km`, data: { bookingId, offerId: offer._id, dispatchVersion, expiresAt } });
      await db.collection('booking_offers_v69').updateOne({ _id: offer._id }, { $set: { 'notification.fcmQueued': true } });
    }
    await db.collection('bookings').updateOne({ _id: bookingId, status: { $in: ['SEARCHING', 'OFFERED'] } }, { $set: { status: 'OFFERED', dispatchEngine: { version: dispatchVersion, currentRound: nextRound, status: 'WAITING', roundExpiresAt: expiresAt, startedAt: booking.dispatchEngine?.startedAt || now, updatedAt: now }, updatedAt: now } });
    await event(bookingId, 'ROUND_STARTED', { round: nextRound, dispatchVersion, candidateCount: candidates.length, expiresAt, adminId });
    return { bookingId: String(bookingId), dispatchVersion, round: nextRound, candidates: candidates.length, expiresAt };
  }

  async function dispatchWithRetry(rawBookingId, options = {}, attempt = 0) {
    const bookingId = oid(rawBookingId);
    if (!bookingId) throw new Error('Booking id không hợp lệ.');
    try {
      const result = await dispatchBooking(bookingId, options);
      await getDb().collection('bookings').updateOne(
        { _id: bookingId },
        { $unset: { 'dispatchEngine.retryCount': '', 'dispatchEngine.nextRetryAt': '', 'dispatchEngine.lastError': '' } },
      ).catch(() => {});
      return result;
    } catch (error) {
      const cfg = await getConfig();
      const delays = Array.isArray(cfg.retry?.retryDelaySeconds) && cfg.retry.retryDelaySeconds.length
        ? cfg.retry.retryDelaySeconds
        : [3, 10, 30];
      const max = Math.max(0, Number(cfg.retry?.maxDispatchRetries ?? 3));
      if (attempt >= max) {
        await getDb().collection('bookings').updateOne(
          { _id: bookingId, status: { $in: ['SEARCHING', 'OFFERED'] } },
          { $set: { 'dispatchEngine.status': 'ERROR', 'dispatchEngine.lastError': error.message, updatedAt: new Date() } },
        ).catch(() => {});
        await event(bookingId, 'DISPATCH_FAILED', { attempt, message: error.message });
        throw error;
      }

      const delaySeconds = Math.max(1, Number(delays[Math.min(attempt, delays.length - 1)] || 3));
      const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);
      const db = getDb();
      await db.collection('booking_offers_v69').updateMany(
        { bookingId, status: 'PENDING' },
        { $set: { status: 'CANCELLED', reason: 'DISPATCH_RETRY', respondedAt: new Date(), updatedAt: new Date() } },
      ).catch(() => {});
      await db.collection('dispatch_rounds_v69').updateMany(
        { bookingId, status: 'WAITING' },
        { $set: { status: 'CANCELLED', reason: 'DISPATCH_RETRY', completedAt: new Date() } },
      ).catch(() => {});
      await db.collection('bookings').updateOne(
        { _id: bookingId, status: { $in: ['SEARCHING', 'OFFERED'] } },
        { $set: {
          status: 'SEARCHING',
          'dispatchEngine.status': 'RETRY_WAIT',
          'dispatchEngine.retryCount': attempt + 1,
          'dispatchEngine.nextRetryAt': nextRetryAt,
          'dispatchEngine.lastError': error.message,
          updatedAt: new Date(),
        } },
      );
      await event(bookingId, 'DISPATCH_RETRY_SCHEDULED', { attempt: attempt + 1, delaySeconds, message: error.message });
      return { retryScheduled: true, attempt: attempt + 1, nextRetryAt };
    }
  }

  async function activeOfferForDriver(driverId) {
    const db = getDb(); const now = new Date();
    const offer = await db.collection('booking_offers_v69').findOne({ driverId, status: 'PENDING', expiresAt: { $gt: now } }, { sort: { offeredAt: -1 } });
    if (!offer) return null;
    const booking = await db.collection('bookings').findOne({ _id: offer.bookingId });
    if (!booking || !['SEARCHING', 'OFFERED'].includes(booking.status)) return null;
    return { offer, booking };
  }

  async function addCooldown(driverId, bookingId, type, seconds, reason) {
    const now = new Date();
    await getDb().collection('driver_cooldowns').insertOne({ driverId, bookingId, type, startsAt: now, expiresAt: new Date(now.getTime() + Number(seconds) * 1000), reason, createdAt: now });
  }

  async function declineOffer({ offerId, driverId, reason = 'OTHER' }) {
    const db = getDb(); const _id = oid(offerId); if (!_id) throw new Error('Offer id không hợp lệ.');
    const now = new Date();
    const updated = await db.collection('booking_offers_v69').findOneAndUpdate({ _id, driverId, status: 'PENDING' }, { $set: { status: 'DECLINED', reason, respondedAt: now, updatedAt: now } }, { returnDocument: 'after' });
    const offer = updated?._id ? updated : updated?.value; if (!offer) throw Object.assign(new Error('Offer không còn hiệu lực.'), { code: 'OFFER_NOT_ACTIVE' });
    const cfg = await getConfig();
    await addCooldown(driverId, offer.bookingId, 'DECLINED', cfg.cooldown.declineSeconds, reason);
    await addCooldown(driverId, offer.bookingId, 'SAME_BOOKING', cfg.cooldown.sameBookingSeconds, 'SAME_BOOKING');
    await event(offer.bookingId, 'OFFER_DECLINED', { driverId, offerId: _id, round: offer.round, reason });
    const left = await db.collection('booking_offers_v69').countDocuments({ bookingId: offer.bookingId, dispatchVersion: offer.dispatchVersion, round: offer.round, status: 'PENDING', expiresAt: { $gt: now } });
    if (!left) await advanceAfterRound(offer.bookingId, offer.dispatchVersion, offer.round, 'ALL_RESPONDED');
    return { ok: true };
  }

  async function acceptOffer({ offerId, driverId, userId, idempotencyKey }) {
    const db = getDb(); const _id = oid(offerId); if (!_id) throw new Error('Offer id không hợp lệ.');
    const key = String(idempotencyKey || crypto.randomUUID());
    const existing = await db.collection('idempotency_keys').findOne({ key, userId, endpoint: 'ACCEPT_OFFER' });
    if (existing?.responseBody) return existing.responseBody;
    const client = getClient ? getClient() : null;
    const session = client?.startSession ? client.startSession() : null;
    const runner = async (s) => {
      const opts = s ? { session: s } : {};
      const now = new Date();
      let offer = await db.collection('booking_offers_v69').findOne({ _id, driverId, status: 'PENDING', expiresAt: { $gt: now } }, opts);
      if (!offer) {
        const accepted = await db.collection('booking_offers_v69').findOne({ _id, driverId, status: 'ACCEPTED' }, opts);
        if (accepted) {
          const acceptedBooking = await db.collection('bookings').findOne({ _id: accepted.bookingId, driverId }, opts);
          if (acceptedBooking) return serializeBooking(acceptedBooking);
        }
        throw Object.assign(new Error('Offer đã hết hạn hoặc không còn hiệu lực.'), { code: 'OFFER_NOT_ACTIVE' });
      }
      const driver = await db.collection('drivers').findOne({ _id: driverId, approvalStatus: 'APPROVED', kycStatus: 'APPROVED', onlineStatus: 'ONLINE' }, opts);
      if (!driver || driver.activeBookingId) throw Object.assign(new Error('Tài xế không còn sẵn sàng.'), { code: 'DRIVER_NOT_AVAILABLE' });
      const policy = await getMatching().getMatchingPolicy();
      const pointAccount = await db.collection('driver_reward_accounts').findOne({ driverId }, opts);
      const pointBalance = Number(pointAccount?.balance || 0);
      if (pointBalance < Number(policy.pointsPolicy?.blockBelow ?? 0)) {
        throw Object.assign(new Error(`Tài xế đang âm điểm (${pointBalance}). Vui lòng nạp điểm trước khi nhận cuốc.`), { code: 'DRIVER_POINTS_BLOCKED' });
      }
      const offeredBooking = await db.collection('bookings').findOne({ _id: offer.bookingId }, opts);
      if (!offeredBooking) throw Object.assign(new Error('Không tìm thấy chuyến.'), { code: 'BOOKING_NOT_FOUND' });
      const serviceCode = String(offeredBooking.serviceCode || 'BIKE').toUpperCase();
      const vehicle = await db.collection('vehicles').findOne({ driverId, status: 'APPROVED', $or: [{ serviceCodes: serviceCode }, { serviceCode }] }, opts);
      if (!vehicle) throw Object.assign(new Error('Phương tiện tài xế không phù hợp loại dịch vụ.'), { code: 'SERVICE_NOT_ELIGIBLE' });
      const user = await db.collection('users').findOne({ _id: driver.userId }, opts);
      const result = await db.collection('bookings').findOneAndUpdate({ _id: offer.bookingId, status: { $in: ['SEARCHING', 'OFFERED'] }, driverId: null }, { $set: { status: 'DRIVER_ASSIGNED', driverId, vehicleId: vehicle?._id || null, driverSnapshot: { fullName: user?.fullName || 'Tài xế', phone: user?.phone || '', rating: Number(driver.rating || 5), vehiclePlate: vehicle?.plateNumber || '', vehicleBrand: vehicle?.brand || '', vehicleModel: vehicle?.model || '', vehicleColor: vehicle?.color || '' }, assignedAt: now, updatedAt: now, 'dispatchEngine.status': 'ASSIGNED', 'dispatchEngine.acceptedOfferId': _id, 'dispatchEngine.assignedAt': now } }, { ...opts, returnDocument: 'after' });
      const booking = result?._id ? result : result?.value;
      if (!booking) throw Object.assign(new Error('Chuyến đã được tài xế khác nhận.'), { code: 'BOOKING_ALREADY_ACCEPTED' });
      await db.collection('drivers').updateOne({ _id: driverId, onlineStatus: 'ONLINE', $or: [{ activeBookingId: null }, { activeBookingId: { $exists: false } }] }, { $set: { onlineStatus: 'BUSY', activeBookingId: offer.bookingId, updatedAt: now } }, opts);
      await db.collection('booking_offers_v69').updateOne({ _id }, { $set: { status: 'ACCEPTED', respondedAt: now, updatedAt: now } }, opts);
      await db.collection('booking_offers_v69').updateMany({ bookingId: offer.bookingId, dispatchVersion: offer.dispatchVersion, _id: { $ne: _id }, status: 'PENDING' }, { $set: { status: 'LOST_RACE', respondedAt: now, updatedAt: now } }, opts);
      await db.collection('dispatch_rounds_v69').updateMany({ bookingId: offer.bookingId, dispatchVersion: offer.dispatchVersion, status: 'WAITING' }, { $set: { status: 'SUCCESS', acceptedDriverId: driverId, completedAt: now } }, opts);
      return serializeBooking(booking);
    };
    const pendingBeforeAccept = await db.collection('booking_offers_v69').find({ _id: { $ne: _id }, status: 'PENDING' }).project({ bookingId: 1, driverId: 1 }).toArray();
    let response;
    if (session) {
      try { await session.withTransaction(async () => { response = await runner(session); }); } finally { await session.endSession(); }
    } else response = await runner(null);
    await db.collection('idempotency_keys').updateOne({ key, userId, endpoint: 'ACCEPT_OFFER' }, { $setOnInsert: { key, userId, endpoint: 'ACCEPT_OFFER', createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000) }, $set: { responseCode: 200, responseBody: response, status: 'COMPLETED', updatedAt: new Date() } }, { upsert: true });
    await event(oid(response.id), 'BOOKING_ACCEPTED', { driverId, offerId: _id });
    const acceptedBookingId = oid(response.id);
    getMatching().emitBookingUpdate(await db.collection('bookings').findOne({ _id: acceptedBookingId }));
    for (const item of pendingBeforeAccept) {
      if (String(item.bookingId) !== String(acceptedBookingId)) continue;
      try {
        getMatching().emitToDriver(item.driverId, 'driver:offer_closed', {
          bookingId: String(acceptedBookingId),
          reason: 'BOOKING_ACCEPTED_BY_OTHER_DRIVER',
        });
      } catch (_) {}
    }
    await notificationService.enqueue({ dedupeKey: `BOOKING_ACCEPTED:${response.id}`, type: 'BOOKING_ACCEPTED', targetType: 'CUSTOMER', targetId: oid(response.customerId), bookingId: oid(response.id), title: 'Đã tìm thấy tài xế', body: `${response.driverName || 'Tài xế'} đã nhận chuyến của bạn.`, data: { bookingId: response.id } });
    return response;
  }

  async function advanceAfterRound(bookingId, dispatchVersion, round, reason) {
    const db = getDb(); const booking = await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking || !['SEARCHING', 'OFFERED'].includes(booking.status) || Number(booking.dispatchEngine?.version) !== Number(dispatchVersion)) return;
    await db.collection('dispatch_rounds_v69').updateOne({ bookingId, dispatchVersion, round, status: 'WAITING' }, { $set: { status: 'TIMEOUT', completedAt: new Date(), reason } });
    await db.collection('bookings').updateOne({ _id: bookingId }, { $set: { status: 'SEARCHING', 'dispatchEngine.status': 'NEXT_ROUND', updatedAt: new Date() } });
    await event(bookingId, 'ROUND_TIMEOUT', { dispatchVersion, round, reason });
    setImmediate(() => dispatchWithRetry(bookingId).catch(e => console.error('[V6.9 Dispatch next round]', e.message)));
  }

  async function sweepExpiredOffers() {
    const db = getDb(); if (!db) return;
    const now = new Date();
    const retryBookings = await db.collection('bookings').find({
      status: { $in: ['SEARCHING', 'OFFERED'] },
      'dispatchEngine.status': 'RETRY_WAIT',
      'dispatchEngine.nextRetryAt': { $lte: now },
    }).limit(25).toArray();
    for (const booking of retryBookings) {
      const attempt = Math.max(0, Number(booking.dispatchEngine?.retryCount || 0));
      await db.collection('bookings').updateOne(
        { _id: booking._id, 'dispatchEngine.status': 'RETRY_WAIT' },
        { $set: { 'dispatchEngine.status': 'RETRYING', updatedAt: now } },
      );
      setImmediate(() => dispatchWithRetry(booking._id, { reset: true }, attempt).catch(e => console.error('[V6.9 Dispatch retry]', e.message)));
    }

    const expired = await db.collection('booking_offers_v69').find({ status: 'PENDING', expiresAt: { $lte: now } }).limit(100).toArray();
    const cfg = await getConfig();
    for (const offer of expired) {
      const changed = await db.collection('booking_offers_v69').updateOne({ _id: offer._id, status: 'PENDING' }, { $set: { status: 'EXPIRED', respondedAt: now, updatedAt: now } });
      if (!changed.modifiedCount) continue;
      await addCooldown(offer.driverId, offer.bookingId, 'OFFER_TIMEOUT', cfg.cooldown.timeoutSeconds, 'OFFER_TIMEOUT');
      await event(offer.bookingId, 'OFFER_EXPIRED', { driverId: offer.driverId, offerId: offer._id, round: offer.round });
    }
    const rounds = await db.collection('dispatch_rounds_v69').find({ status: 'WAITING', expiresAt: { $lte: now } }).limit(50).toArray();
    for (const r of rounds) await advanceAfterRound(r.bookingId, r.dispatchVersion, r.round, 'TIMEOUT');
  }

  async function cancelBooking(rawBookingId, reason = 'BOOKING_TERMINAL') {
    const bookingId = oid(rawBookingId); if (!bookingId) return;
    const now = new Date();
    const pending = await getDb().collection('booking_offers_v69').find({ bookingId, status: 'PENDING' }).project({ driverId: 1 }).toArray();
    await getDb().collection('booking_offers_v69').updateMany({ bookingId, status: 'PENDING' }, { $set: { status: 'CANCELLED', reason, respondedAt: now, updatedAt: now } });
    for (const item of pending) {
      try { getMatching().emitToDriver(item.driverId, 'driver:offer_closed', { bookingId: String(bookingId), reason }); } catch (_) {}
    }
    await getDb().collection('dispatch_rounds_v69').updateMany({ bookingId, status: 'WAITING' }, { $set: { status: 'CANCELLED', completedAt: now, reason } });
  }

  async function manualOffer(rawBookingId, rawDriverId, adminId = null) {
    const bookingId = oid(rawBookingId), driverId = oid(rawDriverId); if (!bookingId || !driverId) throw new Error('ID không hợp lệ.');
    let booking = await getDb().collection('bookings').findOne({ _id: bookingId }); if (!booking || !['SEARCHING', 'OFFERED', 'NO_DRIVER'].includes(booking.status)) throw new Error('Chuyến không còn ở trạng thái có thể điều phối.');
    if (booking.status === 'NO_DRIVER') {
      await getDb().collection('bookings').updateOne({ _id: bookingId, status: 'NO_DRIVER' }, { $set: { status: 'SEARCHING', updatedAt: new Date(), 'dispatchEngine.status': 'ADMIN_REQUEUED' }, $unset: { 'dispatchEngine.completedAt': '' } });
      booking = await getDb().collection('bookings').findOne({ _id: bookingId });
    }
    const driver = await getDb().collection('drivers').findOne({ _id: driverId, onlineStatus: 'ONLINE', approvalStatus: 'APPROVED', kycStatus: 'APPROVED' }); if (!driver || driver.activeBookingId) throw new Error('Tài xế không sẵn sàng.');
    const policy = await getMatching().getMatchingPolicy();
    const pointAccount = await getDb().collection('driver_reward_accounts').findOne({ driverId });
    const pointBalance = Number(pointAccount?.balance || 0);
    if (pointBalance < Number(policy.pointsPolicy?.blockBelow ?? 0)) {
      throw Object.assign(new Error(`Tài xế đang âm điểm (${pointBalance}). Cần nạp điểm trước khi nhận cuốc.`), { code: 'DRIVER_POINTS_BLOCKED' });
    }
    const version = Math.max(1, Number(booking.dispatchEngine?.version || 1)); const now = new Date(); const expiresAt = new Date(now.getTime() + 20000);
    let offer = await getDb().collection('booking_offers_v69').findOne({ bookingId, driverId, dispatchVersion: version });
    if (!offer) {
      const r = await getDb().collection('booking_offers_v69').insertOne({ bookingId, bookingCode: booking.bookingCode, driverId, round: Number(booking.dispatchEngine?.currentRound || 1), rank: 0, matchingScore: 999, matchingSnapshot: { manual: true }, status: 'PENDING', offeredAt: now, expiresAt, respondedAt: null, dispatchVersion: version, manualAttempt: 1, createdAt: now, updatedAt: now });
      offer = await getDb().collection('booking_offers_v69').findOne({ _id: r.insertedId });
    } else {
      const manualAttempt = Number(offer.manualAttempt || 0) + 1;
      await getDb().collection('booking_offers_v69').updateOne({ _id: offer._id }, { $set: { status: 'PENDING', offeredAt: now, expiresAt, respondedAt: null, reason: null, manualAttempt, updatedAt: now } });
      offer = { ...offer, status: 'PENDING', offeredAt: now, expiresAt, respondedAt: null, reason: null, manualAttempt };
    }
    getMatching().emitToDriver(driverId, 'v69:booking_offer', { offerId: String(offer._id), expiresAt: expiresAt.toISOString(), booking: serializeBooking(booking), manual: true });
    await notificationService.enqueue({ dedupeKey: `BOOKING_OFFER_MANUAL:${bookingId}:${driverId}:${version}:${offer.manualAttempt || 1}`, type: 'BOOKING_OFFER', targetType: 'DRIVER', targetId: driverId, bookingId, offerId: offer._id, title: 'Có chuyến được điều phối', body: 'Điều hành iMove vừa phát một chuyến cho bạn.', data: { bookingId, offerId: offer._id, dispatchVersion: version, expiresAt } });
    await getDb().collection('bookings').updateOne(
      { _id: bookingId, status: { $in: ['SEARCHING', 'OFFERED'] } },
      { $set: { status: 'OFFERED', 'dispatchEngine.status': 'WAITING', 'dispatchEngine.roundExpiresAt': expiresAt, updatedAt: new Date() } },
    );
    await event(bookingId, 'ADMIN_MANUAL_OFFER', { driverId, offerId: offer._id, adminId }); return { ok: true, offerId: String(offer._id), expiresAt };
  }

  async function detail(rawBookingId) {
    const bookingId = oid(rawBookingId); if (!bookingId) throw new Error('Booking id không hợp lệ.');
    const db = getDb(); const [booking, rounds, offers, events] = await Promise.all([
      db.collection('bookings').findOne({ _id: bookingId }),
      db.collection('dispatch_rounds_v69').find({ bookingId }).sort({ dispatchVersion: 1, round: 1 }).toArray(),
      db.collection('booking_offers_v69').find({ bookingId }).sort({ offeredAt: 1 }).toArray(),
      db.collection('dispatch_events').find({ bookingId }).sort({ createdAt: 1 }).toArray(),
    ]);
    return { booking: serializeBooking(booking), dispatch: booking?.dispatchEngine || null, rounds, offers, events };
  }

  async function start() { if (started) return; started = true; sweepTimer = setInterval(() => sweepExpiredOffers().catch(e => console.error('[V6.9 Dispatch sweep]', e.message)), 1000); sweepTimer.unref?.(); }
  function close() { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = null; for (const timer of retryTimers.values()) clearTimeout(timer); retryTimers.clear(); }

  return { databaseReady, getConfig, saveConfig, dispatchBooking, dispatchWithRetry, activeOfferForDriver, declineOffer, acceptOffer, sweepExpiredOffers, cancelBooking, manualOffer, detail, start, close, addCooldown };
}

module.exports = { createDispatchEngine, DEFAULT_CONFIG, normalizeConfig };
