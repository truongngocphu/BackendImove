const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const {
  pointValueVnd,
  minimumTopupVnd,
  companyBankInfo,
  ensureDriverPointIndexes,
  syncDriverPointAccount,
  createTopupRequest,
  approveTopupRequest,
  confirmTopupByBankTransfer,
  rejectTopupRequest,
  createAdminPointAdjustment,
  listAdminDriverPointAccounts,
  serializePointAdjustment,
  serializeTopup,
} = require('./driver_points_service');

function oid(value) {
  try { return value instanceof ObjectId ? value : new ObjectId(String(value)); }
  catch (_) { return null; }
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}
function jwtSecret() {
  const value = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (value.length < 32) throw new Error('JWT_ACCESS_SECRET chưa cấu hình an toàn.');
  return value;
}
function startOfLocalDay(offsetHours = 7) {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetHours * 3600000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetHours * 3600000);
}
function serializeDate(v) {
  if (!v) return null;
  try { return new Date(v).toISOString(); } catch (_) { return null; }
}

async function ensureIndexes(db) {
  await ensureDriverPointIndexes(db);
  await Promise.allSettled([
    db.collection('driver_reward_accounts').createIndex({ driverId: 1 }, { unique: true, name: 'uq_driver_reward_account' }),
    db.collection('driver_reward_transactions').createIndex({ sourceTransactionId: 1 }, { unique: true, sparse: true, name: 'uq_driver_reward_source_tx' }),
    db.collection('driver_reward_transactions').createIndex({ sourceBookingId: 1 }, { unique: true, sparse: true, name: 'uq_driver_reward_booking_v140' }),
    db.collection('driver_reward_transactions').createIndex({ driverId: 1, createdAt: -1 }, { name: 'idx_driver_reward_history' }),
    db.collection('driver_incentives').createIndex({ status: 1, startsAt: 1, endsAt: 1 }, { name: 'idx_driver_incentive_active' }),
    db.collection('driver_incentive_progress').createIndex({ driverId: 1, incentiveId: 1, periodKey: 1 }, { unique: true, name: 'uq_driver_incentive_progress' }),
    db.collection('demand_zones').createIndex({ status: 1, priority: -1 }, { name: 'idx_demand_zones_active' }),
  ]);
}

async function findDriverContext(db, req, findDriverByPhone) {
  const phone = req.auth?.user?.phone;
  if (!phone) return null;
  const found = await findDriverByPhone(phone);
  if (!found?.driver || !found?.user) return null;
  return found;
}

async function syncDriverPoints(db, ctx) {
  return syncDriverPointAccount(db, ctx);
}

async function loadRatings(db, ctx, limit = 50) {
  const rows = await db.collection('ratings')
    .find({ toUserId: ctx.user._id })
    .project({ score: 1, comment: 1, tags: 1, createdAt: 1, bookingId: 1 })
    .sort({ createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
    .toArray();
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  for (const r of rows) {
    const score = Math.max(1, Math.min(5, Math.round(num(r.score, 5))));
    counts[score] += 1;
    total += score;
  }
  const count = rows.length;
  const average = count ? Number((total / count).toFixed(2)) : num(ctx.driver.rating, 5);
  return {
    average,
    count: num(ctx.driver.ratingCount, count),
    distribution: counts,
    items: rows.map((x) => ({
      id: String(x._id),
      score: num(x.score, 5),
      comment: clean(x.comment, 600),
      tags: Array.isArray(x.tags) ? x.tags : [],
      bookingId: x.bookingId ? String(x.bookingId) : null,
      createdAt: serializeDate(x.createdAt),
      customerLabel: 'Khách hàng ẩn danh',
    })),
  };
}

async function activeIncentives(db, driverId) {
  const now = new Date();
  const rows = await db.collection('driver_incentives')
    .find({ status: 'ACTIVE', startsAt: { $lte: now }, endsAt: { $gte: now } })
    .sort({ priority: -1, createdAt: -1 })
    .limit(20)
    .toArray();
  const dayStart = startOfLocalDay(7);
  const completedToday = await db.collection('bookings').countDocuments({ driverId, status: 'COMPLETED', completedAt: { $gte: dayStart } });
  return rows.map((x) => {
    const targetTrips = Math.max(1, Math.trunc(num(x.targetTrips, 1)));
    const progress = Math.min(targetTrips, completedToday);
    return {
      id: String(x._id),
      code: x.code || String(x._id),
      title: x.title || 'Nhiệm vụ tài xế',
      description: x.description || '',
      rewardAmount: Math.trunc(num(x.rewardAmount)),
      rewardPoints: Math.trunc(num(x.rewardPoints)),
      targetTrips,
      completedTrips: progress,
      progressPercent: Math.round((progress / targetTrips) * 100),
      startsAt: serializeDate(x.startsAt),
      endsAt: serializeDate(x.endsAt),
      zoneCode: x.zoneCode || null,
      serviceCode: x.serviceCode || 'ALL',
    };
  });
}

function createDriverExperienceRouter({ getDb, findDriverByPhone }) {
  const router = express.Router();
  let initialized = false;
  router.use(async (_req, _res, next) => {
    if (!initialized) {
      initialized = true;
      await ensureIndexes(getDb());
    }
    next();
  });

  router.get('/dashboard', async (req, res) => {
    try {
      const db = getDb();
      const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const dayStart = startOfLocalDay(7);
      const [points, ratings, incentives, zones, activeBooking, todayTrips] = await Promise.all([
        syncDriverPoints(db, ctx),
        loadRatings(db, ctx, 8),
        activeIncentives(db, ctx.driver._id),
        db.collection('demand_zones').find({ status: 'ACTIVE' }).sort({ priority: -1 }).limit(8).toArray(),
        db.collection('bookings').findOne({ driverId: ctx.driver._id, status: { $in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] } }, { sort: { updatedAt: -1 } }),
        db.collection('bookings').countDocuments({ driverId: ctx.driver._id, status: 'COMPLETED', completedAt: { $gte: dayStart } }),
      ]);
      const pointsTodayAgg = await db.collection('driver_reward_transactions').aggregate([
        { $match: { driverId: ctx.driver._id, createdAt: { $gte: dayStart }, points: { $gt: 0 } } },
        { $group: { _id: null, points: { $sum: '$points' } } },
      ]).toArray();
      const trust = await db.collection('trust_profiles').findOne({ subjectId: ctx.driver._id, subjectType: 'DRIVER' });
      return res.json({
        profile: {
          id: String(ctx.driver._id),
          fullName: ctx.user.fullName || ctx.driver.fullName || 'Tài xế',
          phone: ctx.user.phone || ctx.driver.phone || '',
          avatarUrl: ctx.user.avatarUrl || null,
          rating: ratings.average,
          ratingCount: ratings.count,
          onlineStatus: ctx.driver.onlineStatus || 'OFFLINE',
          approvalStatus: ctx.driver.approvalStatus || 'PENDING',
          kycStatus: ctx.driver.kycStatus || 'PENDING',
        },
        today: {
          pointBalance: Math.trunc(num(points?.balance)),
          pointsToday: Math.trunc(num(points?.balance)), // backward compatibility
          completedTrips: todayTrips,
          completionRate: Math.round(num(ctx.driver.completionRate, 98)),
        },
        points: {
          balance: Math.trunc(num(points?.balance)),
          lifetimeEarned: Math.trunc(num(points?.lifetimeEarned)),
          lifetimeSpent: Math.trunc(num(points?.lifetimeSpent)),
          conversionText: `${pointValueVnd().toLocaleString('vi-VN')}đ = 1 điểm`,
        },
        trust: {
          riskScore: Math.trunc(num(trust?.riskScore)),
          riskLevel: trust?.riskLevel || 'LOW',
          trustScore: Math.max(0, 100 - Math.trunc(num(trust?.riskScore))),
        },
        incentives,
        demandZones: zones.map((z) => ({
          id: String(z._id), code: z.code, name: z.name, demandLevel: z.demandLevel || 'NORMAL', demandPercent: num(z.demandPercent), incomeBoostPercent: num(z.incomeBoostPercent), center: z.center || null,
        })),
        activeBooking: activeBooking ? { id: String(activeBooking._id), code: activeBooking.bookingCode, status: activeBooking.status, pickup: activeBooking.pickup, destination: activeBooking.destination, pricing: activeBooking.pricing } : null,
      });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });



  router.get('/services', async (req, res) => {
    try {
      const db = getDb();
      const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const vehicle = await db.collection('vehicles').findOne({ driverId: ctx.driver._id }, { sort: { updatedAt: -1 } });
      const requestedServiceCodes = Array.isArray(vehicle?.requestedServiceCodes) && vehicle.requestedServiceCodes.length
        ? vehicle.requestedServiceCodes
        : (Array.isArray(ctx.driver.requestedServiceCodes) ? ctx.driver.requestedServiceCodes : []);
      const approvedServiceCodes = Array.isArray(vehicle?.approvedServiceCodes) && vehicle.approvedServiceCodes.length
        ? vehicle.approvedServiceCodes
        : (Array.isArray(ctx.driver.approvedServiceCodes) && ctx.driver.approvedServiceCodes.length
          ? ctx.driver.approvedServiceCodes
          : (vehicle?.status === 'APPROVED' && Array.isArray(vehicle?.serviceCodes) ? vehicle.serviceCodes : []));
      const rawPreferences = {
        ...(ctx.driver.servicePreferences && typeof ctx.driver.servicePreferences === 'object' ? ctx.driver.servicePreferences : {}),
        ...(vehicle?.servicePreferences && typeof vehicle.servicePreferences === 'object' ? vehicle.servicePreferences : {}),
      };
      const servicePreferences = Object.fromEntries(
        approvedServiceCodes.map((code) => [String(code).toUpperCase(), rawPreferences[String(code).toUpperCase()] !== false]),
      );
      return res.json({
        vehicleType: vehicle?.vehicleType || ctx.driver.vehicleType || ctx.driver.requestedVehicleType || 'MOTORBIKE',
        requestedServiceCodes,
        approvedServiceCodes,
        servicePreferences,
        vehicleStatus: vehicle?.status || 'PENDING',
      });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.post('/services/preferences', async (req, res) => {
    try {
      const db = getDb();
      const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const vehicle = await db.collection('vehicles').findOne({ driverId: ctx.driver._id, status: 'APPROVED' }, { sort: { updatedAt: -1 } });
      if (!vehicle) return res.status(409).json({ message: 'Phương tiện chưa được duyệt.' });
      const approvedServiceCodes = Array.isArray(vehicle.approvedServiceCodes) && vehicle.approvedServiceCodes.length
        ? vehicle.approvedServiceCodes.map((code) => String(code).toUpperCase())
        : (Array.isArray(vehicle.serviceCodes) ? vehicle.serviceCodes.map((code) => String(code).toUpperCase()) : [String(vehicle.serviceCode || 'BIKE').toUpperCase()]);
      const input = req.body?.servicePreferences && typeof req.body.servicePreferences === 'object'
        ? req.body.servicePreferences
        : {};
      const servicePreferences = Object.fromEntries(
        approvedServiceCodes.map((code) => [code, input[code] !== false]),
      );
      if (!Object.values(servicePreferences).some(Boolean)) {
        return res.status(400).json({ message: 'Phải bật ít nhất một dịch vụ nhận đơn.' });
      }
      const changedAt = new Date();
      await Promise.all([
        db.collection('vehicles').updateOne({ _id: vehicle._id }, { $set: { servicePreferences, updatedAt: changedAt } }),
        db.collection('drivers').updateOne({ _id: ctx.driver._id }, { $set: { servicePreferences, updatedAt: changedAt } }),
      ]);
      return res.json({ ok: true, approvedServiceCodes, servicePreferences });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.get('/trips', async (req, res) => {
    try {
      const db=getDb(); const ctx=await findDriverContext(db,req,findDriverByPhone);
      if(!ctx)return res.status(404).json({message:'Không tìm thấy tài xế.'});
      const { normalizeDriverTripHistory }=require('./driver_history_service');
      const rows=await db.collection('bookings').find({driverId:ctx.driver._id}).sort({createdAt:-1}).limit(Math.min(200,Number(req.query.limit)||100)).toArray();
      return res.json({trips:normalizeDriverTripHistory(rows)});
    } catch(error){return res.status(500).json({message:error.message});}
  });

  router.get('/earnings', async (req, res) => {
    try {
      const db=getDb(); const ctx=await findDriverContext(db,req,findDriverByPhone);
      if(!ctx)return res.status(404).json({message:'Không tìm thấy tài xế.'});
      const { normalizeDriverTripHistory, summarizeDriverEarnings }=require('./driver_history_service');
      const days=Math.max(1,Math.min(365,Number(req.query.days)||30));
      const since=new Date(Date.now()-days*86400000);
      const bookings=await db.collection('bookings').find({driverId:ctx.driver._id,status:'COMPLETED',completedAt:{$gte:since}}).sort({completedAt:-1}).limit(500).toArray();
      const rows=normalizeDriverTripHistory(bookings);
      const bookingIds=bookings.map(x=>x._id);
      const walletRows=bookingIds.length?await db.collection('wallet_transactions').find({bookingId:{$in:bookingIds},type:'DRIVER_TRIP_EARNING',status:'COMPLETED'}).project({bookingId:1,amount:1}).toArray():[];
      const postedByBooking=new Map(walletRows.map(x=>[String(x.bookingId),num(x.amount)]));
      const enriched=rows.map(x=>({...x,postedAmount:postedByBooking.get(x.id)||0,settlementStatus:(postedByBooking.get(x.id)||0)>0?'SETTLED':x.settlementStatus}));
      return res.json({days,...summarizeDriverEarnings(enriched),trips:enriched});
    } catch(error){return res.status(500).json({message:error.message});}
  });

  router.get('/points', async (req, res) => {
    try {
      const db = getDb(); const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const account = await syncDriverPoints(db, ctx);
      const tx = await db.collection('driver_reward_transactions').find({ driverId: ctx.driver._id }).sort({ createdAt: -1 }).limit(100).toArray();
      return res.json({
        account: { balance: num(account?.balance), lifetimeEarned: num(account?.lifetimeEarned), lifetimeSpent: num(account?.lifetimeSpent), conversionText: `${pointValueVnd().toLocaleString('vi-VN')}đ = 1 điểm` },
        transactions: tx.map((x) => ({ id: String(x._id), type: x.type, title: x.title, points: num(x.points), amountVnd: num(x.amountVnd), reason: x.reason || null, reference: x.reference || null, direction: x.direction || null, bookingId: x.bookingId ? String(x.bookingId) : null, createdAt: serializeDate(x.createdAt) })),
      });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/point-topup-info', async (req, res) => {
    try {
      const db = getDb(); const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      return res.json({
        pointValueVnd: pointValueVnd(),
        minimumTopupVnd: minimumTopupVnd(),
        bankInfo: companyBankInfo(),
      });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/point-topups', async (req, res) => {
    try {
      const db = getDb(); const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const rows = await db.collection('driver_point_topups')
        .find({ driverId: ctx.driver._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();
      return res.json({ topups: rows.map(serializeTopup) });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.post('/point-topups', async (req, res) => {
    try {
      const db = getDb(); const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const row = await createTopupRequest(db, {
        driverId: ctx.driver._id,
        userId: ctx.user._id,
        amountVnd: req.body?.amountVnd,
        driverName: ctx.user?.fullName || ctx.driver?.fullName || '',
        driverPhone: ctx.user?.phone || ctx.driver?.phone || '',
      });
      return res.status(201).json({ topup: serializeTopup(row) });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.get('/ratings', async (req, res) => {
    try {
      const db = getDb(); const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      return res.json(await loadRatings(db, ctx, req.query.limit));
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/incentives', async (req, res) => {
    try {
      const db = getDb(); const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      return res.json(await activeIncentives(db, ctx.driver._id));
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/heatmap', async (_req, res) => {
    try {
      const rows = await getDb().collection('demand_zones').find({ status: 'ACTIVE' }).sort({ priority: -1 }).limit(50).toArray();
      return res.json(rows.map((z) => ({ id: String(z._id), code: z.code, name: z.name, demandLevel: z.demandLevel || 'NORMAL', demandPercent: num(z.demandPercent), incomeBoostPercent: num(z.incomeBoostPercent), center: z.center || null, radiusKm: num(z.radiusKm, 2) })));
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/vehicle', async (req, res) => {
    try {
      const db = getDb(); const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const vehicle = await db.collection('vehicles').findOne({ driverId: ctx.driver._id }, { sort: { updatedAt: -1 } });
      if (!vehicle) return res.json({ vehicle: null });
      return res.json({ vehicle: { id: String(vehicle._id), serviceCode: vehicle.serviceCode || vehicle.serviceCodes?.[0] || 'BIKE', serviceCodes: Array.isArray(vehicle.serviceCodes) ? vehicle.serviceCodes : [vehicle.serviceCode || 'BIKE'], plateNumber: vehicle.plateNumber || '', brand: vehicle.brand || '', model: vehicle.model || '', color: vehicle.color || '', year: vehicle.year || null, status: vehicle.status || 'PENDING', verificationStatus: vehicle.verificationStatus || vehicle.status || 'PENDING', registrationStatus: vehicle.registrationStatus || null, inspectionExpiresAt: serializeDate(vehicle.inspectionExpiresAt), insuranceExpiresAt: serializeDate(vehicle.insuranceExpiresAt) } });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/risk-summary', async (req, res) => {
    try {
      const db = getDb(); const ctx = await findDriverContext(db, req, findDriverByPhone);
      if (!ctx) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const [profile, events, latestDevice, latestFace] = await Promise.all([
        db.collection('trust_profiles').findOne({ subjectId: ctx.driver._id, subjectType: 'DRIVER' }),
        db.collection('risk_events').find({ subjectId: ctx.driver._id, subjectType: 'DRIVER' }).sort({ createdAt: -1 }).limit(20).toArray(),
        db.collection('trusted_devices').findOne({ userId: ctx.user._id, role: 'DRIVER', status: { $ne: 'REVOKED' } }, { sort: { lastSeenAt: -1 } }),
        db.collection('identity_verifications').findOne({ userId: ctx.user._id, role: 'DRIVER', status: 'PASSED' }, { sort: { createdAt: -1 } }),
      ]);
      const riskScore = Math.trunc(num(profile?.riskScore));
      const stepUp = Math.max(1, Math.trunc(num(process.env.TRUST_STEP_UP_THRESHOLD, 50)));
      const restrictAt = Math.max(stepUp, Math.trunc(num(process.env.TRUST_RESTRICT_THRESHOLD, 85)));
      const maxFaceHours = Math.max(1, num(process.env.DRIVER_FACE_MAX_HOURS, 12));
      const faceAgeHours = latestFace?.createdAt ? (Date.now() - new Date(latestFace.createdAt).getTime()) / 3600000 : Number.POSITIVE_INFINITY;
      return res.json({
        riskScore,
        trustScore: Math.max(0, 100 - riskScore),
        riskLevel: profile?.riskLevel || 'LOW',
        restricted: riskScore >= restrictAt,
        requiresFaceCheck: riskScore >= stepUp || faceAgeHours > maxFaceHours || latestDevice?.trusted !== true,
        deviceTrusted: latestDevice?.trusted === true,
        lastFaceAt: serializeDate(latestFace?.createdAt),
        events: events.map((x) => ({ id: String(x._id), type: x.type, severity: x.severity, riskPoints: num(x.riskPoints), status: x.status, createdAt: serializeDate(x.createdAt), evidence: x.evidence || {} })),
      });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  return router;
}

function createAdminAuth(getDb) {
  return async function admin(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Thiếu token Admin.' });
      const payload = jwt.verify(header.slice(7), jwtSecret());
      const id = oid(payload.sub || payload.userId);
      const user = id ? await getDb().collection('users').findOne({ _id: id, roles: 'ADMIN' }) : null;
      if (!user) return res.status(403).json({ message: 'Không có quyền ADMIN.' });
      req.admin = user;
      return next();
    } catch (_) { return res.status(401).json({ message: 'Phiên Admin không hợp lệ.' }); }
  };
}

function createDriverExperienceAdminRouter({ getDb, getNotifications = null }) {
  const router = express.Router();
  router.use(createAdminAuth(getDb));

  router.get('/overview', async (_req, res) => {
    try {
      const db = getDb();
      const [activeIncentives, zones, rewardAccounts, avgRating] = await Promise.all([
        db.collection('driver_incentives').countDocuments({ status: 'ACTIVE', endsAt: { $gte: new Date() } }),
        db.collection('demand_zones').countDocuments({ status: 'ACTIVE' }),
        db.collection('driver_reward_accounts').countDocuments({}),
        db.collection('drivers').aggregate([{ $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }]).toArray(),
      ]);
      return res.json({ activeIncentives, activeDemandZones: zones, rewardAccounts, averageRating: Number(num(avgRating[0]?.average, 0).toFixed(2)), driverCount: num(avgRating[0]?.count) });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/incentives', async (_req, res) => {
    const rows = await getDb().collection('driver_incentives').find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return res.json(rows.map((x) => ({ ...x, _id: String(x._id) })));
  });
  router.post('/incentives', async (req, res) => {
    try {
      const now = new Date();
      const doc = {
        code: clean(req.body?.code || `INC-${Date.now()}`, 60).toUpperCase(),
        title: clean(req.body?.title, 160),
        description: clean(req.body?.description, 500),
        rewardAmount: Math.max(0, Math.trunc(num(req.body?.rewardAmount))),
        rewardPoints: Math.max(0, Math.trunc(num(req.body?.rewardPoints))),
        targetTrips: Math.max(1, Math.trunc(num(req.body?.targetTrips, 1))),
        serviceCode: clean(req.body?.serviceCode || 'ALL', 30).toUpperCase(),
        zoneCode: clean(req.body?.zoneCode, 60) || null,
        priority: Math.trunc(num(req.body?.priority, 0)),
        startsAt: req.body?.startsAt ? new Date(req.body.startsAt) : now,
        endsAt: req.body?.endsAt ? new Date(req.body.endsAt) : new Date(now.getTime() + 7 * 86400000),
        status: String(req.body?.status || 'ACTIVE').toUpperCase(),
        createdBy: req.admin._id,
        createdAt: now,
        updatedAt: now,
      };
      const r = await getDb().collection('driver_incentives').insertOne(doc);
      return res.status(201).json({ ...doc, _id: String(r.insertedId) });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });
  router.put('/incentives/:id', async (req, res) => {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    const patch = { updatedAt: new Date() };
    for (const key of ['title', 'description', 'serviceCode', 'zoneCode', 'status']) if (req.body?.[key] !== undefined) patch[key] = clean(req.body[key], key === 'description' ? 500 : 160);
    for (const key of ['rewardAmount', 'rewardPoints', 'targetTrips', 'priority']) if (req.body?.[key] !== undefined) patch[key] = Math.trunc(num(req.body[key]));
    if (req.body?.startsAt) patch.startsAt = new Date(req.body.startsAt);
    if (req.body?.endsAt) patch.endsAt = new Date(req.body.endsAt);
    await getDb().collection('driver_incentives').updateOne({ _id: id }, { $set: patch });
    return res.json({ ok: true });
  });

  router.get('/zones', async (_req, res) => {
    const rows = await getDb().collection('demand_zones').find({}).sort({ priority: -1 }).limit(200).toArray();
    return res.json(rows.map((x) => ({ ...x, _id: String(x._id) })));
  });
  router.post('/zones', async (req, res) => {
    try {
      const doc = {
        code: clean(req.body?.code || `ZONE-${Date.now()}`, 60).toUpperCase(),
        name: clean(req.body?.name, 120),
        demandLevel: clean(req.body?.demandLevel || 'NORMAL', 30).toUpperCase(),
        demandPercent: num(req.body?.demandPercent),
        incomeBoostPercent: num(req.body?.incomeBoostPercent),
        center: req.body?.center && Number.isFinite(Number(req.body.center.lat)) && Number.isFinite(Number(req.body.center.lng)) ? { lat: Number(req.body.center.lat), lng: Number(req.body.center.lng) } : null,
        radiusKm: Math.max(0.2, num(req.body?.radiusKm, 2)),
        priority: Math.trunc(num(req.body?.priority, 0)),
        status: String(req.body?.status || 'ACTIVE').toUpperCase(),
        createdBy: req.admin._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const r = await getDb().collection('demand_zones').insertOne(doc);
      return res.status(201).json({ ...doc, _id: String(r.insertedId) });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });
  router.put('/zones/:id', async (req, res) => {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    const patch = { updatedAt: new Date() };
    for (const key of ['name', 'demandLevel', 'status']) if (req.body?.[key] !== undefined) patch[key] = clean(req.body[key], 120);
    for (const key of ['demandPercent', 'incomeBoostPercent', 'radiusKm', 'priority']) if (req.body?.[key] !== undefined) patch[key] = num(req.body[key]);
    if (req.body?.center) patch.center = { lat: Number(req.body.center.lat), lng: Number(req.body.center.lng) };
    await getDb().collection('demand_zones').updateOne({ _id: id }, { $set: patch });
    return res.json({ ok: true });
  });


  router.get('/point-accounts', async (req, res) => {
    try {
      const drivers = await listAdminDriverPointAccounts(getDb(), {
        keyword: req.query.q,
        limit: req.query.limit,
      });
      return res.json({ drivers });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/point-adjustments', async (req, res) => {
    try {
      const driverId = oid(req.query.driverId);
      const query = { type: 'ADMIN_ADJUSTMENT' };
      if (driverId) query.driverId = driverId;
      const rows = await getDb().collection('driver_reward_transactions')
        .find(query)
        .sort({ createdAt: -1 })
        .limit(Math.max(1, Math.min(300, Number(req.query.limit) || 100)))
        .toArray();
      return res.json({ adjustments: rows.map(serializePointAdjustment) });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.post('/point-adjustments', async (req, res) => {
    try {
      const raw = Math.trunc(num(req.body?.points));
      const direction = clean(req.body?.direction || 'CREDIT', 20).toUpperCase();
      const signedPoints = direction === 'DEBIT' ? -Math.abs(raw) : Math.abs(raw);
      const idempotencyKey = clean(req.headers['idempotency-key'] || req.body?.idempotencyKey, 120);
      const result = await createAdminPointAdjustment(getDb(), {
        driverId: req.body?.driverId,
        points: signedPoints,
        reason: req.body?.reason,
        reference: req.body?.reference,
        adminId: req.admin._id,
        idempotencyKey,
      });
      if (!result.existing) {
        await getDb().collection('audit_logs').insertOne({
          actorType: 'ADMIN',
          actorId: req.admin._id,
          action: signedPoints >= 0 ? 'DRIVER_POINTS_ADMIN_CREDIT' : 'DRIVER_POINTS_ADMIN_DEBIT',
          entityType: 'DRIVER',
          entityId: String(req.body?.driverId || ''),
          after: {
            points: signedPoints,
            balance: result.account?.balance ?? null,
            reason: clean(req.body?.reason, 500),
            reference: clean(req.body?.reference, 160) || null,
            sourceTransactionId: result.transaction?.sourceTransactionId || null,
          },
          createdAt: new Date(),
        });
        const notifications = getNotifications ? getNotifications() : null;
        if (notifications) {
          await notifications.enqueue({
            dedupeKey: `DRIVER_POINTS_ADMIN_ADJUST:${result.transaction?.sourceTransactionId}`,
            type: 'DRIVER_POINTS_ADJUSTED',
            targetType: 'DRIVER',
            targetId: oid(req.body?.driverId),
            title: signedPoints >= 0 ? 'Admin đã cộng điểm' : 'Admin đã điều chỉnh điểm',
            body: `${signedPoints >= 0 ? '+' : ''}${signedPoints} điểm · Số dư mới ${Math.trunc(num(result.account?.balance))} điểm.`,
            data: {
              points: signedPoints,
              balance: Math.trunc(num(result.account?.balance)),
              reason: clean(req.body?.reason, 500),
              action: 'OPEN_POINTS',
            },
            level: signedPoints < 0 ? 2 : 3,
          }).catch(() => {});
        }
      }
      return res.status(result.existing ? 200 : 201).json({
        ok: true,
        existing: Boolean(result.existing),
        driver: result.driver,
        balance: Math.trunc(num(result.account?.balance)),
        transaction: serializePointAdjustment(result.transaction),
      });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.get('/point-topups', async (req, res) => {
    try {
      const status = clean(req.query.status || '', 40).toUpperCase();
      const keyword = clean(req.query.q || '', 120).toLowerCase();
      const query = status && status !== 'ALL' ? { status } : {};
      const rows = await getDb().collection('driver_point_topups')
        .find(query)
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();
      const driverIds = [...new Set(rows.map((x) => String(x.driverId)))].map(oid).filter(Boolean);
      const drivers = driverIds.length
        ? await getDb().collection('drivers').find({ _id: { $in: driverIds } }).project({ fullName: 1, phone: 1, userId: 1 }).toArray()
        : [];
      const byDriver = new Map(drivers.map((x) => [String(x._id), x]));
      const mapped = rows.map((x) => ({
        ...serializeTopup(x),
        driver: (() => {
          const snap = x.driverSnapshot || null;
          const d = byDriver.get(String(x.driverId));
          return {
            id: String(x.driverId),
            fullName: snap?.fullName || d?.fullName || '',
            phone: snap?.phone || d?.phone || '',
          };
        })(),
      }));
      const filtered = keyword
        ? mapped.filter((x) => [
            x.driver?.fullName,
            x.driver?.phone,
            x.transferCode,
            x.transferContent,
            x.bankTransactionId,
          ].some((v) => String(v || '').toLowerCase().includes(keyword)))
        : mapped;
      return res.json({ topups: filtered });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.post('/point-topups/:id/approve', async (req, res) => {
    try {
      const row = await approveTopupRequest(getDb(), { topupId: req.params.id, adminId: req.admin._id });
      return res.json({ ok: true, topup: serializeTopup(row) });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.post('/point-topups/:id/reject', async (req, res) => {
    try {
      const row = await rejectTopupRequest(getDb(), {
        topupId: req.params.id,
        adminId: req.admin._id,
        reason: req.body?.reason,
      });
      return res.json({ ok: true, topup: serializeTopup(row) });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  return router;
}


function safeSecretEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return require('crypto').timingSafeEqual(left, right);
}

function createDriverPointBankWebhookRouter({ getDb }) {
  const router = express.Router();
  router.post('/driver-point-topup', async (req, res) => {
    try {
      const expected = String(process.env.BANK_WEBHOOK_SECRET || '').trim();
      if (expected.length < 24) {
        return res.status(503).json({ message: 'BANK_WEBHOOK_SECRET chưa được cấu hình.' });
      }
      const provided = String(req.headers['x-imove-bank-secret'] || '').trim();
      if (!safeSecretEqual(expected, provided)) {
        return res.status(401).json({ message: 'Bank webhook secret không hợp lệ.' });
      }
      const result = await confirmTopupByBankTransfer(getDb(), {
        bankTransactionId: req.body?.bankTransactionId,
        amountVnd: req.body?.amountVnd,
        transferContent: req.body?.transferContent,
        occurredAt: req.body?.occurredAt,
      });
      return res.json({ ok: true, status: result.status, topup: serializeTopup(result.topup) });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });
  return router;
}

module.exports = {
  createDriverExperienceRouter,
  createDriverExperienceAdminRouter,
  createDriverPointBankWebhookRouter,
  ensureIndexes,
};
