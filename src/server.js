const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const { calculateFare } = require('./fare_engine');
const { createKycRouter } = require('./kyc_routes');
const { createAdminAuthRouter } = require('./admin_auth_routes');
const { createAdminOpsRouter } = require('./admin_ops_routes');
const { createMatchingAdminRouter } = require('./matching_admin_routes');
const { getLanAddresses, startLanDiscovery, startServiceRegistry } = require('./lan_discovery');
const { createBookingSecurity } = require('./booking_security');
const { createAuthRouter } = require('./auth_routes');
const { createMatchingEngine } = require('./matching_engine');
const { createPlatformService } = require('./platform_service');
const { createNotificationService } = require('./notification_service');
const { createDispatchEngine } = require('./dispatch_engine');
const { createDispatchAdminRouter } = require('./dispatch_admin_routes');
const { createTrustService } = require('./trust_service');
const { createTrustRouter, createTrustAdminRouter } = require('./trust_routes');
const { createBroadcastRouter } = require('./broadcast_routes');
const { createDriverExperienceRouter, createDriverExperienceAdminRouter, createDriverPointBankWebhookRouter } = require('./driver_experience_routes');
const { createProductionService } = require('./production_service');
const { createProductionPublicRouter, createProductionDriverRouter, createProductionAdminRouter } = require('./production_routes');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { assertProductionConfig, buildCorsOptions } = require('./production_guard');
const { createMapRouter } = require('./map_routes');
const { createServiceCatalogService } = require('./service_catalog_service');
const { createServiceCatalogPublicRouter, createServiceCatalogAdminRouter } = require('./service_catalog_routes');
const { createPricingService } = require('./pricing_service');
const { createPricingPublicRouter, createPricingAdminRouter } = require('./pricing_routes');
const { createPromotionService } = require('./promotion_service');
const { createPromotionCustomerRouter, createPromotionAdminRouter } = require('./promotion_routes');
const { createAnalyticsService } = require('./analytics_service');
const { createAnalyticsAdminRouter } = require('./analytics_routes');
const { repairDatabase, completionCollectionForStep, validationDetails } = require('./database_repair');
const { createCommercePublicRouter, createMerchantRouter, createCommerceDriverRouter, createCommerceAdminRouter, createCommerceDispatchWorker } = require('./commerce_routes');
const { createAdminConsoleRouter } = require('./admin_console_routes');
const { version: PACKAGE_VERSION } = require('../package.json');

const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const PRODUCTION = NODE_ENV === 'production';
const APP_VERSION = String(process.env.APP_VERSION || PACKAGE_VERSION || '1.6.0').trim();
const PORT = Number(process.env.PORT || 5050);
const HOST = String(process.env.HOST || (PRODUCTION ? '127.0.0.1' : '0.0.0.0')).trim();
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const DB_NAME = String(process.env.MONGODB_DB || 'th79_imove').trim();
const RETRY_MS = Math.max(3000, Number(process.env.MONGO_RETRY_SECONDS || 5) * 1000);
const DEFAULT_BOOKING_TIMEOUT_SECONDS = Math.max(60, Number(process.env.BOOKING_SEARCH_TIMEOUT_SECONDS || 300));
const DEMO_RUNTIME_ENABLED = !PRODUCTION &&
  String(process.env.SEED_DEMO_ON_START || 'false').toLowerCase() === 'true';
const DB_REPAIR_ON_START = String(
  process.env.DB_REPAIR_ON_START ?? (PRODUCTION ? 'false' : 'true'),
).toLowerCase() === 'true';
const LAN_DISCOVERY_ENABLED = String(
  process.env.LAN_DISCOVERY_ENABLED ?? (PRODUCTION ? 'false' : 'true'),
).toLowerCase() === 'true';
const SERVICE_REGISTRY_ENABLED = String(
  process.env.SERVICE_REGISTRY_ENABLED ?? (PRODUCTION ? 'false' : 'true'),
).toLowerCase() === 'true';

assertProductionConfig();

const app = express();
app.set('trust proxy', 1);
function isLoopbackAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

app.use((req, res, next) => {
  const forceHttps = String(process.env.FORCE_HTTPS || 'false').toLowerCase() === 'true';
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  // Nginx/PM2 health checks hit the loopback HTTP listener directly. External traffic
  // is still required to be HTTPS when FORCE_HTTPS=true.
  if (PRODUCTION && forceHttps && !isLoopbackAddress(req.socket?.remoteAddress) && proto !== 'https') {
    return res.status(426).json({ code: 'HTTPS_REQUIRED', message: 'Production TH79 iMove chỉ chấp nhận HTTPS.' });
  }
  next();
});
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: Math.max(60, Number(process.env.API_RATE_LIMIT_PER_MINUTE || 600)), standardHeaders: 'draft-7', legacyHeaders: false }));

let mongoClient = null;
let db = null;
let mongoConnected = false;
let lastMongoError = null;
let retryTimer = null;
let connecting = false;
let matching = null;
let platformService = null;
let notificationService = null;
let dispatchEngine = null;
let trustService = null;
let productionService = null;
let commerceDispatchWorker = null;
const serviceCatalogService = createServiceCatalogService({ getDb: () => db });
const pricingService = createPricingService({ getDb: () => db });
const promotionService = createPromotionService({ getDb: () => db });
const analyticsService = createAnalyticsService({ getDb: () => db });
productionService = createProductionService({
  getDb: () => db,
  getMongoConnected: () => mongoConnected,
  getNotifications: () => notificationService,
  getMatching: () => matching,
  getDispatch: () => dispatchEngine,
  getSocketServer: () => matching?.io || null,
});
app.use(productionService.requestMetricsMiddleware());

const now = () => new Date();

function bookingCode() {
  const d = new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const tail = String(Date.now()).slice(-7);
  return `IM${y}${m}${day}${tail}`;
}

function safeObjectId(value) {
  try { return new ObjectId(value); } catch (_) { return null; }
}

function maskedMongoUri() {
  if (!MONGODB_URI) return '(chua cau hinh)';
  return MONGODB_URI.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)[^@]+@/i, '$1********@');
}

async function ensureCustomer({ phone, fullName, email }) {
  let user = await db.collection('users').findOne({ phone });
  if (user) return user;
  const doc = {
    phone,
    fullName: fullName || 'Khách hàng TH79',
    email: email || null,
    passwordHash: null,
    avatarUrl: null,
    status: 'ACTIVE',
    roles: ['CUSTOMER'],
    lastLoginAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
  const result = await db.collection('users').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

async function ensureDemoDriver() {
  let user = await db.collection('users').findOne({ phone: '0909000001' });
  if (!user) {
    const doc = {
      phone: '0909000001',
      fullName: 'Tài xế Demo',
      email: 'driver.demo@th79.vn',
      passwordHash: null,
      avatarUrl: null,
      status: 'ACTIVE',
      roles: ['DRIVER'],
      lastLoginAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    const result = await db.collection('users').insertOne(doc);
    user = { ...doc, _id: result.insertedId };
  }

  let driver = await db.collection('drivers').findOne({ userId: user._id });
  if (!driver) {
    const doc = {
      userId: user._id,
      approvalStatus: 'APPROVED',
      kycStatus: 'APPROVED',
      documentsStatus: {
        cccd: 'APPROVED',
        driverLicense: 'APPROVED',
        vehicleRegistration: 'APPROVED',
        criminalRecord: 'APPROVED',
        vehiclePhotos: 'APPROVED',
        bankAccount: 'APPROVED',
        avatar: 'APPROVED',
      },
      onlineStatus: 'OFFLINE',
      rating: 4.9,
      completedTrips: 0,
      cancelledTrips: 0,
      acceptanceRate: 100,
      approvedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    };
    const result = await db.collection('drivers').insertOne(doc);
    driver = { ...doc, _id: result.insertedId };
  }

  let vehicle = await db.collection('vehicles').findOne({ driverId: driver._id, status: 'APPROVED' });
  if (!vehicle) {
    const doc = {
      driverId: driver._id,
      serviceCode: 'BIKE',
      plateNumber: '59X1-123.45',
      brand: 'Honda',
      model: 'Wave Alpha',
      color: 'Đen',
      year: 2025,
      status: 'APPROVED',
      createdAt: now(),
      updatedAt: now(),
    };
    const result = await db.collection('vehicles').insertOne(doc);
    vehicle = { ...doc, _id: result.insertedId };
  }
  return { user, driver, vehicle };
}

async function findDriverByPhone(phone) {
  const user = await db.collection('users').findOne({ phone, roles: 'DRIVER' });
  if (!user) return null;
  const driver = await db.collection('drivers').findOne({ userId: user._id });
  if (!driver) return null;
  const vehicle = await db.collection('vehicles').findOne({ driverId: driver._id, status: 'APPROVED' });
  return { user, driver, vehicle };
}

function iso(value) {
  if (!value) return null;
  try { return value.toISOString ? value.toISOString() : new Date(value).toISOString(); } catch (_) { return null; }
}

function serializeBooking(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    code: doc.bookingCode,
    serviceCode: String(doc.serviceCode || 'BIKE').toUpperCase(),
    customerId: String(doc.customerId),
    customerName: doc.customerSnapshot?.fullName || null,
    customerPhone: doc.customerSnapshot?.phone || null,
    driverId: doc.driverId ? String(doc.driverId) : null,
    driverName: doc.driverSnapshot?.fullName || null,
    driverPhone: doc.driverSnapshot?.phone || null,
    driverRating: Number.isFinite(Number(doc.driverSnapshot?.rating)) ? Number(doc.driverSnapshot.rating) : null,
    vehiclePlate: doc.driverSnapshot?.vehiclePlate || null,
    vehicleBrand: doc.driverSnapshot?.vehicleBrand || null,
    vehicleModel: doc.driverSnapshot?.vehicleModel || null,
    vehicleColor: doc.driverSnapshot?.vehicleColor || null,
    pickup: {
      address: doc.pickup?.address || '',
      latitude: Number(doc.pickup?.location?.coordinates?.[1] || 0),
      longitude: Number(doc.pickup?.location?.coordinates?.[0] || 0),
    },
    destination: {
      address: doc.destination?.address || '',
      latitude: Number(doc.destination?.location?.coordinates?.[1] || 0),
      longitude: Number(doc.destination?.location?.coordinates?.[0] || 0),
    },
    quote: doc.pricing || {},
    fareSnapshot: doc.fareSnapshot || null,
    status: doc.status,
    paymentMethod: doc.paymentMethod || 'CASH',
    cancellation: doc.cancellation || null,
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

async function addEvent(bookingId, type, actorType, actorId = null, payload = null) {
  try {
    await db.collection('booking_events').insertOne({ bookingId, type, actorType, actorId, payload, createdAt: now() });
  } catch (error) {
    console.warn('booking_events insert skipped:', error.message);
  }
}

async function setDriverAvailable(driverId) {
  if (!driverId) return;
  await db.collection('drivers').updateOne(
    { _id: driverId },
    {
      $set: {
        onlineStatus: 'ONLINE',
        activeBookingId: null,
        currentOfferBookingId: null,
        currentOfferExpiresAt: null,
        updatedAt: now(),
      },
    },
  );
}

async function getBookingTimeoutSeconds() {
  try {
    const settings = await db.collection('app_settings').findOne({ key: 'BIKE_BOOKING_CONFIG', status: 'ACTIVE' });
    const value = Number(settings?.value?.bookingTimeoutSeconds || DEFAULT_BOOKING_TIMEOUT_SECONDS);
    return Math.max(60, value);
  } catch (_) {
    return DEFAULT_BOOKING_TIMEOUT_SECONDS;
  }
}

async function expireOldBookings() {
  if (!db) return;
  const timeoutSeconds = await getBookingTimeoutSeconds();
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
  const expired = await db.collection('bookings').find({
    status: 'SEARCHING',
    createdAt: { $lt: cutoff },
  }).project({ _id: 1 }).toArray();
  if (expired.length === 0) return;

  const ids = expired.map((x) => x._id);
  const changedAt = now();
  await db.collection('bookings').updateMany(
    { _id: { $in: ids }, status: 'SEARCHING' },
    { $set: { status: 'EXPIRED', expiredAt: changedAt, updatedAt: changedAt } },
  );
  try {
    await db.collection('booking_events').insertMany(ids.map((bookingId) => ({
      bookingId,
      type: 'BOOKING_EXPIRED',
      actorType: 'SYSTEM',
      actorId: null,
      payload: { status: 'EXPIRED', timeoutSeconds },
      createdAt: changedAt,
    })));
  } catch (_) {}
  if (matching) {
    for (const bookingId of ids) {
      const booking = await db.collection('bookings').findOne({ _id: bookingId });
      if (booking?.status === 'EXPIRED') await matching.onBookingTerminal(booking);
    }
  }
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    backend: true,
    service: 'TH79_IMOVE_CORE',
    name: 'TH79 iMove API',
    version: APP_VERSION,
    environment: NODE_ENV,
    message: 'Backend đang chạy. Dùng /live cho liveness, /health cho MongoDB và /ready cho readiness đầy đủ.',
  });
});

// Liveness: chỉ xác nhận process Node/Express còn sống. Không phụ thuộc MongoDB/Redis/FCM.
app.get('/live', (_req, res) => {
  res.status(200).json({
    ok: true,
    backend: true,
    service: 'TH79_IMOVE_CORE',
    version: APP_VERSION,
    environment: NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    generatedAt: new Date(),
  });
});

// Health: endpoint ổn định cho Admin Gateway/Nginx. HTTP 200 khi MongoDB sẵn sàng.
app.get('/health', async (_req, res) => {
  try {
    const health = await productionService.systemHealth();
    mongoConnected = Boolean(health?.components?.mongodb?.ok);
    const payload = {
      ...health,
      ok: mongoConnected,
      ready: Boolean(health?.ok),
      backend: true,
      service: 'TH79_IMOVE_CORE',
      name: 'TH79 iMove API',
      version: APP_VERSION,
      database: mongoConnected,
      databaseName: DB_NAME,
      mongoConfigured: Boolean(MONGODB_URI),
      lastMongoError,
    };
    if (!PRODUCTION) payload.mongoUri = maskedMongoUri();
    return res.status(mongoConnected ? 200 : 503).json(payload);
  } catch (error) {
    return res.status(503).json({
      ok: false,
      ready: false,
      backend: true,
      service: 'TH79_IMOVE_CORE',
      name: 'TH79 iMove API',
      version: APP_VERSION,
      message: error.message,
    });
  }
});

// Readiness: dùng cho kiểm tra toàn bộ dependency được cấu hình là bắt buộc.
app.get('/ready', async (_req, res) => {
  try {
    const health = await productionService.systemHealth();
    return res.status(health.ok ? 200 : 503).json({
      ok: health.ok,
      backend: true,
      service: 'TH79_IMOVE_CORE',
      version: APP_VERSION,
      components: health.components,
      generatedAt: health.generatedAt,
    });
  } catch (error) {
    return res.status(503).json({ ok: false, backend: true, service: 'TH79_IMOVE_CORE', version: APP_VERSION, message: error.message });
  }
});


app.get('/api/network/info', (_req, res) => {
  res.json({
    ok: true,
    service: 'TH79_IMOVE_CORE',
    httpPort: PORT,
    discoveryPort: Number(process.env.LAN_DISCOVERY_PORT || 5051),
    addresses: getLanAddresses(),
  });
});

app.use('/api/v73', createProductionPublicRouter({ getProduction: () => productionService }));
app.use('/api/maps', createMapRouter());

app.use('/api', (_req, res, next) => {
  if (db && mongoConnected) return next();
  return res.status(503).json({
    message: 'Backend đang chạy nhưng MongoDB Atlas chưa kết nối. Kiểm tra MONGODB_URI, Database Access và Network Access.',
  });
});

app.use('/api', async (req, res, next) => {
  try {
    const path = String(req.path || '');
    if (path.startsWith('/v73/app-config') || path.startsWith('/admin-auth') || path.startsWith('/v73/admin')) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const cfg = await productionService.loadProductionConfig();
    if (cfg.maintenanceMode) return res.status(503).json({ code: 'MAINTENANCE_MODE', message: cfg.maintenanceMessage || 'TH79 iMove đang bảo trì.' });
    return next();
  } catch (_) { return next(); }
});

app.use('/api/auth', createAuthRouter({ getDb: () => db }));

const {
  requireCustomer,
  requireApprovedDriver,
  requireBookingParticipant,
  requireAssignedDriver,
  requireCancelParticipant,
} = createBookingSecurity({ getDb: () => db });
app.use('/api/kyc', createKycRouter({ getDb: () => db }));
app.use('/api/admin-auth', createAdminAuthRouter({ getDb: () => db }));
app.use('/api/v7/admin', createAdminOpsRouter({ getDb: () => db }));
app.use('/api/v8/admin/matching', createMatchingAdminRouter({ getDb: () => db, getMatching: () => matching }));
platformService = createPlatformService({
  getDb: () => db,
  getClient: () => mongoClient,
  getMatching: () => matching,
});
app.use('/api/v6', platformService.router);

// V6.9 Notification + Dispatch Engine
app.post('/api/v69/driver/devices/register', requireApprovedDriver, async (req, res) => {
  try {
    const found = await findDriverByPhone(req.auth.user.phone);
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    return res.json(await notificationService.registerDevice({ userId: found.driver._id, userType: 'DRIVER', ...req.body }));
  } catch (e) { return res.status(400).json({ message: e.message }); }
});
app.post('/api/v69/customer/devices/register', requireCustomer, async (req, res) => {
  try { return res.json(await notificationService.registerDevice({ userId: req.auth.user._id, userType: 'CUSTOMER', ...req.body })); }
  catch (e) { return res.status(400).json({ message: e.message }); }
});
app.delete('/api/v69/driver/devices/current', requireApprovedDriver, async (req, res) => {
  const found = await findDriverByPhone(req.auth.user.phone); if (!found) return res.status(404).json({message:'Không tìm thấy tài xế.'});
  return res.json(await notificationService.disableDevice({ userId: found.driver._id, token: req.body?.token, deviceId: req.body?.deviceId }));
});
app.delete('/api/v69/customer/devices/current', requireCustomer, async (req, res) => res.json(await notificationService.disableDevice({ userId: req.auth.user._id, token: req.body?.token, deviceId: req.body?.deviceId })));
app.get('/api/v69/driver/offers/active', requireApprovedDriver, async (req, res) => {
  try { const found = await findDriverByPhone(req.auth.user.phone); if (!found) return res.status(404).json({message:'Không tìm thấy tài xế.'}); const active = await dispatchEngine.activeOfferForDriver(found.driver._id); return res.json(active ? { offer: { id: String(active.offer._id), bookingId: String(active.offer.bookingId), round: active.offer.round, expiresAt: active.offer.expiresAt, matchingScore: active.offer.matchingScore, booking: serializeBooking(active.booking) } } : { offer: null }); }
  catch(e){return res.status(500).json({message:e.message});}
});
app.post('/api/v69/driver/offers/:offerId/accept', requireApprovedDriver, async (req, res) => {
  try { const found = await findDriverByPhone(req.auth.user.phone); if (!found) return res.status(404).json({message:'Không tìm thấy tài xế.'}); const value = await dispatchEngine.acceptOffer({ offerId:req.params.offerId, driverId:found.driver._id, userId:req.auth.user._id, idempotencyKey:req.headers['idempotency-key'] }); await addEvent(safeObjectId(value.id),'DRIVER_ACCEPTED','DRIVER',found.driver._id,{source:'V69_DISPATCH'}); return res.json(value); }
  catch(e){const code=['BOOKING_ALREADY_ACCEPTED','OFFER_NOT_ACTIVE','DRIVER_NOT_AVAILABLE'].includes(e.code)?409:500;return res.status(code).json({code:e.code||null,message:e.message});}
});
app.post('/api/v69/driver/offers/:offerId/decline', requireApprovedDriver, async (req, res) => {
  try { const found = await findDriverByPhone(req.auth.user.phone); if (!found) return res.status(404).json({message:'Không tìm thấy tài xế.'}); return res.json(await dispatchEngine.declineOffer({offerId:req.params.offerId,driverId:found.driver._id,reason:req.body?.reason||'OTHER'})); }
  catch(e){return res.status(e.code==='OFFER_NOT_ACTIVE'?409:500).json({code:e.code||null,message:e.message});}
});
app.post('/api/v69/driver/heartbeat', requireApprovedDriver, async (req, res) => {
  try { const found=await findDriverByPhone(req.auth.user.phone); if(!found)return res.status(404).json({message:'Không tìm thấy tài xế.'}); const nowDate=new Date(); const lat=Number(req.body?.lat),lng=Number(req.body?.lng); await db.collection('drivers').updateOne({_id:found.driver._id},{$set:{lastHeartbeatAt:nowDate,updatedAt:nowDate}}); if(Number.isFinite(lat)&&Number.isFinite(lng)) { await db.collection('driver_locations').updateOne({driverId:found.driver._id},{$set:{driverId:found.driver._id,location:{type:'Point',coordinates:[lng,lat]},heading:Number(req.body?.heading||0),speed:Number(req.body?.speed||0),updatedAt:nowDate},$setOnInsert:{createdAt:nowDate}},{upsert:true}); if(trustService) await trustService.analyzeLocation({driverId:found.driver._id,userId:found.user._id,lat,lng,isMocked:Boolean(req.body?.isMocked),accuracy:req.body?.accuracy,timestamp:req.body?.timestamp}); } return res.json({ok:true,serverTime:nowDate}); } catch(e){return res.status(500).json({message:e.message});}
});
app.get('/api/v69/driver/notifications', requireApprovedDriver, async (req,res)=>{const found=await findDriverByPhone(req.auth.user.phone);if(!found)return res.status(404).json({message:'Không tìm thấy tài xế.'});return res.json(await notificationService.listNotifications(found.driver._id,req.query.limit));});
app.get('/api/v69/customer/notifications', requireCustomer, async (req,res)=>res.json(await notificationService.listNotifications(req.auth.user._id,req.query.limit)));
app.post('/api/v69/driver/notifications/:id/read', requireApprovedDriver, async (req,res)=>{const found=await findDriverByPhone(req.auth.user.phone);return res.json({ok:await notificationService.markRead(found.driver._id,req.params.id)});});
app.post('/api/v69/customer/notifications/:id/read', requireCustomer, async (req,res)=>res.json({ok:await notificationService.markRead(req.auth.user._id,req.params.id)}));
app.use('/api/v69/admin/dispatch', createDispatchAdminRouter({ getDb:()=>db, getDispatch:()=>dispatchEngine, getNotifications:()=>notificationService }));

// V7.1 Admin Broadcast Center
app.get('/api/v71/customer/notifications', requireCustomer, async (req, res) => {
  try {
    const rows = await notificationService.listNotifications(req.auth.user._id, req.query.limit);
    return res.json(rows.map((item) => ({
      id: String(item._id),
      title: item.title,
      body: item.body,
      type: item.type,
      level: item.level,
      data: item.data || {},
      requireAck: Boolean(item.requireAck),
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
      acknowledgedAt: item.acknowledgedAt,
      readAt: item.readAt,
      status: item.status,
    })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});
app.get('/api/v71/customer/notifications/critical', requireCustomer, async (req, res) => {
  try {
    const items = await notificationService.listPendingCritical(req.auth.user._id, req.query.limit);
    return res.json(items.map((item) => ({
      id: String(item._id),
      title: item.title,
      body: item.body,
      type: item.type,
      level: item.level,
      data: item.data || {},
      requireAck: Boolean(item.requireAck),
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
      acknowledgedAt: item.acknowledgedAt,
      readAt: item.readAt,
    })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});
app.post('/api/v71/customer/notifications/:id/read', requireCustomer, async (req, res) => {
  try {
    return res.json({
      ok: await notificationService.markRead(req.auth.user._id, req.params.id),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
app.delete('/api/v71/customer/notifications/:id', requireCustomer, async (req, res) => {
  try {
    return res.json({
      ok: await notificationService.deleteNotification(req.auth.user._id, req.params.id),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
app.delete('/api/v71/customer/notifications', requireCustomer, async (req, res) => {
  try {
    return res.json({
      ok: true,
      deleted: await notificationService.deleteAllNotifications(req.auth.user._id),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
app.post('/api/v71/customer/notifications/:id/ack', requireCustomer, async (req, res) => {
  try {
    return res.json({
      ok: await notificationService.acknowledge(req.auth.user._id, req.params.id),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
app.get('/api/v71/driver/notifications', requireApprovedDriver, async (req, res) => {
  try {
    const found = await findDriverByPhone(req.auth.user.phone);
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    const rows = await notificationService.listNotifications(found.driver._id, req.query.limit);
    return res.json(rows.map((item) => ({
      id: String(item._id),
      title: item.title,
      body: item.body,
      type: item.type,
      level: item.level,
      data: item.data || {},
      requireAck: Boolean(item.requireAck),
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
      acknowledgedAt: item.acknowledgedAt,
      readAt: item.readAt,
      status: item.status,
    })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});
app.get('/api/v71/driver/notifications/critical', requireApprovedDriver, async (req, res) => {
  try {
    const found = await findDriverByPhone(req.auth.user.phone);
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    const items = await notificationService.listPendingCritical(found.driver._id, req.query.limit);
    return res.json(items.map((item) => ({
      id: String(item._id),
      title: item.title,
      body: item.body,
      type: item.type,
      level: item.level,
      data: item.data || {},
      requireAck: Boolean(item.requireAck),
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
      acknowledgedAt: item.acknowledgedAt,
      readAt: item.readAt,
    })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});
app.post('/api/v71/driver/notifications/:id/read', requireApprovedDriver, async (req, res) => {
  try {
    const found = await findDriverByPhone(req.auth.user.phone);
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    return res.json({
      ok: await notificationService.markRead(found.driver._id, req.params.id),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
app.delete('/api/v71/driver/notifications/:id', requireApprovedDriver, async (req, res) => {
  try {
    const found = await findDriverByPhone(req.auth.user.phone);
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    return res.json({
      ok: await notificationService.deleteNotification(found.driver._id, req.params.id),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
app.delete('/api/v71/driver/notifications', requireApprovedDriver, async (req, res) => {
  try {
    const found = await findDriverByPhone(req.auth.user.phone);
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    return res.json({
      ok: true,
      deleted: await notificationService.deleteAllNotifications(found.driver._id),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
app.post('/api/v71/driver/notifications/:id/ack', requireApprovedDriver, async (req, res) => {
  try {
    const found = await findDriverByPhone(req.auth.user.phone);
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    return res.json({
      ok: await notificationService.acknowledge(found.driver._id, req.params.id),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
app.use('/api/v71/admin/broadcasts', createBroadcastRouter({
  getDb: () => db,
  getNotifications: () => notificationService,
}));

// V1.4 Service/Pricing/Promotion APIs
app.use('/api/services', createServiceCatalogPublicRouter({ getCatalog:()=>serviceCatalogService }));
app.use('/api/pricing', createPricingPublicRouter({ getPricing:()=>pricingService }));
app.use('/api/promotions', createPromotionCustomerRouter({ getPromotion:()=>promotionService, requireCustomer }));
app.use('/api/v14/admin/services', createServiceCatalogAdminRouter({ getDb:()=>db, getCatalog:()=>serviceCatalogService }));
app.use('/api/v14/admin/pricing', createPricingAdminRouter({ getDb:()=>db, getPricing:()=>pricingService }));
app.use('/api/v14/admin/promotions', createPromotionAdminRouter({ getDb:()=>db, getPromotion:()=>promotionService }));
app.use('/api/v14/admin/analytics', createAnalyticsAdminRouter({ getDb:()=>db, getAnalytics:()=>analyticsService }));

// V1.6 Multi-service Commerce + Merchant
app.use('/api/v16/commerce', createCommercePublicRouter({ getDb:()=>db, requireCustomer, getPricing:()=>pricingService, getNotifications:()=>notificationService }));
app.use('/api/v16/merchant', createMerchantRouter({ getDb:()=>db, getNotifications:()=>notificationService }));
app.use('/api/v16/driver', createCommerceDriverRouter({ getDb:()=>db, requireApprovedDriver, findDriverByPhone, getNotifications:()=>notificationService }));
app.use('/api/v16/admin/commerce', createCommerceAdminRouter({ getDb:()=>db, getNotifications:()=>notificationService }));

// V7.2 Driver Experience API
app.use('/api/v72/driver', requireApprovedDriver, createDriverExperienceRouter({ getDb:()=>db, findDriverByPhone }));
app.use('/api/v72/admin/driver-experience', createDriverExperienceAdminRouter({ getDb:()=>db, getNotifications:()=>notificationService }));
app.use('/api/v72/bank', createDriverPointBankWebhookRouter({ getDb:()=>db }));
app.use('/api/v73/driver', requireApprovedDriver, createProductionDriverRouter({ getDb:()=>db, getProduction:()=>productionService, findDriverByPhone }));
app.use('/api/v73/admin', createProductionAdminRouter({ getDb:()=>db, getProduction:()=>productionService, getPlatform:()=>platformService }));

app.use('/api/v70', createTrustRouter({ getDb:()=>db, getTrust:()=>trustService, getProduction:()=>productionService, findDriverByPhone }));
app.use('/api/admin/v70/trust', createTrustAdminRouter({ getDb:()=>db, getTrust:()=>trustService }));


app.post('/api/fares/estimate', async (req, res) => {
  try {
    const result = await pricingService.estimateFare({
      serviceCode: req.body?.serviceCode || 'BIKE',
      areaCode: req.body?.areaCode || 'GLOBAL',
      distanceKm: Number(req.body?.distanceKm || 0),
      durationMinutes: Number(req.body?.durationMinutes || 0),
    });
    if (!result.available) return res.status(409).json(result);
    return res.json(result.fareSnapshot);
  } catch (error) {
    console.error('[Pricing V1.4]', error.message);
    return res.status(400).json({ message: error.message || 'Không thể tính giá chuyến.' });
  }
});

app.post('/api/drivers/status', requireApprovedDriver, async (req, res) => {
  try {
    const phone = req.auth.user.phone;
    const isOnline = Boolean(req.body?.isOnline);
    let found = await findDriverByPhone(phone);
    if (!found && DEMO_RUNTIME_ENABLED && phone === '0909000001') found = await ensureDemoDriver();
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    if (found.driver.approvalStatus !== 'APPROVED' || found.driver.kycStatus !== 'APPROVED') {
      return res.status(403).json({ message: 'Tài xế chưa được duyệt đầy đủ KYC.' });
    }
    if (found.driver.onlineStatus === 'BUSY') {
      return res.status(409).json({ message: 'Tài xế đang có chuyến, không thể đổi trạng thái Online/Offline.' });
    }
    if (isOnline && trustService) {
      const trustCheck = await trustService.canDriverGoOnline({ driver: found.driver, user: found.user });
      if (!trustCheck.ok) return res.status(428).json({ code: trustCheck.code, message: trustCheck.message, trust: trustCheck });
    }
    if (isOnline && productionService) {
      const health = await productionService.driverHealth({ driver: found.driver, user: found.user });
      if (!health.canGoOnline) return res.status(428).json({ code: 'DRIVER_HEALTH_REQUIRED', message: 'Thiết bị hoặc tài khoản chưa đạt điều kiện để Online.', health });
    }
    if (isOnline && matching) {
      const check = await matching.driverCanGoOnline(found.driver._id);
      if (!check.ok) return res.status(409).json({ message: check.message });
    }

    const onlineStatus = isOnline ? 'ONLINE' : 'OFFLINE';
    await db.collection('drivers').updateOne(
      { _id: found.driver._id },
      { $set: { onlineStatus, updatedAt: now() } },
    );

    if (!isOnline && matching) {
      await matching.onDriverOffline(found.driver._id);
    }

    let pointStatus = null;
    if (isOnline) {
      try {
        const policy = await matching?.getMatchingPolicy?.();
        const pointAccount = await db.collection('driver_reward_accounts').findOne({ driverId: found.driver._id });
        const balance = Number(pointAccount?.balance || 0);
        const blockBelow = Number(policy?.pointsPolicy?.blockBelow ?? 0);
        const warnBelow = Number(policy?.pointsPolicy?.warnBelow ?? 20);
        const blocked = balance < blockBelow;
        const low = !blocked && balance <= warnBelow;
        pointStatus = { balance, blocked, low, blockBelow, warnBelow };
        if ((blocked || low) && notificationService) {
          const dateKey = new Date().toISOString().slice(0, 10);
          await notificationService.enqueue({
            dedupeKey: `DRIVER_POINTS_${blocked ? 'BLOCKED' : 'LOW'}:${found.driver._id}:${dateKey}`,
            type: blocked ? 'DRIVER_POINTS_BLOCKED' : 'DRIVER_POINTS_LOW',
            targetType: 'DRIVER',
            targetId: found.driver._id,
            title: blocked ? 'Điểm tài xế đang âm' : 'Điểm tài xế sắp hết',
            body: blocked
              ? `Số dư hiện tại ${balance} điểm. Hệ thống tạm ngừng phát cuốc cho bạn cho đến khi nạp thêm điểm.`
              : `Bạn còn ${balance} điểm. Nên nạp thêm điểm để tránh gián đoạn nhận cuốc.`,
            data: { balance, blockBelow, warnBelow, action: 'OPEN_POINTS_TOPUP' },
            level: blocked ? 2 : 3,
          }).catch(() => {});
        }
      } catch (_) {}
    }

    return res.json({ ok: true, onlineStatus, pointStatus });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/drivers/location', requireApprovedDriver, async (req, res) => {
  try {
    if (!matching) return res.status(503).json({ message: 'Matching Engine chưa sẵn sàng.' });
    const result = await matching.updateLocationByContext(req.driverContext, req.body || {});
    return res.json(result);
  } catch (error) {
    const status = error.code === 'DRIVER_OFFLINE' ? 409 : 400;
    return res.status(status).json({ code: error.code || null, message: error.message });
  }
});

app.get('/api/matching/config', (_req, res) => {
  return res.json(matching ? matching.getPublicConfig() : { enabled: false, realtime: false });
});

app.get('/api/matching/stats', async (_req, res) => {
  try {
    if (!matching) return res.status(503).json({ message: 'Matching Engine chưa sẵn sàng.' });
    return res.json(await matching.stats());
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/bookings', requireCustomer, async (req, res) => {
  try {
    const body = req.body || {};
    const customer = {
      id: String(req.auth.user._id),
      fullName: req.auth.user.fullName,
      phone: req.auth.user.phone,
      email: req.auth.user.email || null,
    };
    const pickup = body.pickup || {};
    const destination = body.destination || {};
    const clientQuote = body.quote || {};
    if (!customer.phone || !pickup.address || !destination.address) {
      return res.status(400).json({ message: 'Thiếu thông tin khách hàng hoặc điểm đón/điểm đến.' });
    }

    const serviceCode = String(body.serviceCode || 'BIKE').toUpperCase();
    const areaCode = String(body.areaCode || 'GLOBAL').toUpperCase();
    const distanceKm = Number(clientQuote.distanceKm || body.distanceKm || 0);
    const durationMinutes = Number(clientQuote.durationMinutes || body.durationMinutes || 0);

    // Không tin giá/giảm giá từ Flutter. Backend luôn tính lại từ Atlas.
    const pricingResult = await pricingService.estimateFare({ serviceCode, areaCode, distanceKm, durationMinutes });
    if (!pricingResult.available) return res.status(409).json({ code:'FARE_UNAVAILABLE', message: pricingResult.reason, serviceCode });
    let quote = { ...pricingResult.fareSnapshot };
    const customerUser = await ensureCustomer(customer);
    let promotionSnapshot = null;
    if (body.promotionCode) {
      const promotion = await promotionService.validatePromotion({ userId: customerUser._id, code: body.promotionCode, serviceCode, orderAmount: quote.customerTotal });
      promotionSnapshot = promotion.snapshot;
      quote = { ...quote, customerTotalBeforeDiscount: quote.customerTotal, discountAmount: promotion.discount, customerTotal: promotion.finalAmount, total: promotion.finalAmount, platformRevenueEstimate: Math.max(0, Number(quote.platformRevenueEstimate||0)-promotion.discount) };
    }

    // V6.6.1: one customer can only own one active ride at a time.
    // This prevents double taps, browser refreshes and request retries from
    // creating two simultaneous bookings for the same customer.
    const existingActiveBooking = await db.collection('bookings').findOne(
      {
        customerId: customerUser._id,
        status: { $in: ['SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
      },
      { sort: { createdAt: -1 } },
    );
    if (existingActiveBooking) {
      return res.status(409).json({
        code: 'ACTIVE_BOOKING_EXISTS',
        message: 'Bạn đang có một chuyến đang hoạt động. iMove sẽ mở lại chuyến đó.',
        booking: serializeBooking(existingActiveBooking),
      });
    }

    const createdAt = now();
    const doc = {
      bookingCode: bookingCode(),
      customerId: customerUser._id,
      driverId: null,
      vehicleId: null,
      serviceCode,
      areaCode,
      status: 'SEARCHING',
      pickup: {
        address: pickup.address,
        note: pickup.note || null,
        location: { type: 'Point', coordinates: [Number(pickup.longitude || 0), Number(pickup.latitude || 0)] },
      },
      destination: {
        address: destination.address,
        note: destination.note || null,
        location: { type: 'Point', coordinates: [Number(destination.longitude || 0), Number(destination.latitude || 0)] },
      },
      estimatedDistanceKm: quote.distanceKm,
      estimatedDurationMinutes: quote.durationMinutes,
      actualDistanceKm: null,
      actualDurationMinutes: null,
      paymentMethod: body.paymentMethod || 'CASH',
      paymentStatus: 'UNPAID',
      fareConfigVersion: Number(quote.fareConfigVersion || 1),
      platformFeeVersion: Number(quote.platformFeeVersion || 1),
      pricing: quote,
      fareSnapshot: quote,
      promotionSnapshot,
      customerSnapshot: {
        externalId: customer.id || null,
        fullName: customer.fullName || customerUser.fullName,
        phone: customer.phone,
        email: customer.email || null,
      },
      cancellation: null,
      requestedAt: createdAt,
      assignedAt: null,
      driverDepartedAt: null,
      driverArrivedAt: null,
      startedAt: null,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
    };

    const result = await db.collection('bookings').insertOne(doc);
    doc._id = result.insertedId;
    if (promotionSnapshot?.promotionId) {
      await promotionService.redeemPromotion({ bookingId: result.insertedId, userId: customerUser._id, promotionId: promotionSnapshot.promotionId, discountAmount: promotionSnapshot.discountAmount });
    }
    await addEvent(result.insertedId, 'BOOKING_CREATED', 'CUSTOMER', customerUser._id, { status: 'SEARCHING', serviceCode, promotionCode: promotionSnapshot?.code || null });
    if (dispatchEngine) {
      setImmediate(() => dispatchEngine.dispatchWithRetry(result.insertedId, { reset: true }).catch((error) => {
        console.error('[V6.9 Dispatch] Dispatch booking failed:', error.message);
      }));
    } else if (matching) {
      setImmediate(() => matching.dispatchBooking(result.insertedId).catch((error) => {
        console.error('[Matching] Dispatch booking failed:', error.message);
      }));
    }
    return res.status(201).json(serializeBooking(doc));
  } catch (error) {
    console.error(error);
    return res.status(400).json({ message: error.message });
  }
});

app.get('/api/bookings/available', requireApprovedDriver, async (req, res) => {
  try {
    await expireOldBookings();
    const driverPhone = req.auth.user.phone;
    let found = await findDriverByPhone(driverPhone);
    if (!found && DEMO_RUNTIME_ENABLED && driverPhone === '0909000001') found = await ensureDemoDriver();
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    if (found.driver.approvalStatus !== 'APPROVED' || found.driver.kycStatus !== 'APPROVED') {
      return res.status(403).json({ message: 'Tài xế chưa được duyệt đầy đủ KYC.' });
    }
    // BUSY is an expected state while the driver is performing a trip.
    // The Driver app may still issue a fallback poll during route transitions;
    // return an empty offer list instead of a noisy 403. OFFLINE remains forbidden.
    if (found.driver.onlineStatus === 'BUSY') {
      return res.json([]);
    }
    if (found.driver.onlineStatus !== 'ONLINE') {
      return res.status(403).json({ message: 'Tài xế đang OFFLINE.' });
    }
    if (!matching) return res.status(503).json({ message: 'Matching Engine chưa sẵn sàng.' });
    return res.json(await matching.getAvailableOffers(found.driver._id));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/bookings/:id/decline', requireApprovedDriver, async (req, res) => {
  try {
    const id = safeObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Booking id không hợp lệ.' });
    const driverPhone = req.auth.user.phone;
    let found = await findDriverByPhone(driverPhone);
    if (!found && DEMO_RUNTIME_ENABLED && driverPhone === '0909000001') found = await ensureDemoDriver();
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    if (!matching) return res.status(503).json({ message: 'Matching Engine chưa sẵn sàng.' });

    const booking = await db.collection('bookings').findOne({ _id: id, status: 'SEARCHING' });
    if (!booking) return res.status(409).json({ message: 'Chuyến không còn khả dụng.' });

    const reason = String(req.body?.reason || 'DRIVER_NOT_INTERESTED');
    await matching.declineOffer(id, found.driver._id, reason);
    return res.json({ ok: true, message: 'Đã từ chối chuyến. Hệ thống sẽ chuyển cho tài xế khác.' });
  } catch (error) {
    const status = error.code === 'OFFER_NOT_ACTIVE' ? 409 : 500;
    return res.status(status).json({ code: error.code || null, message: error.message });
  }
});

app.get('/api/bookings/:id', requireBookingParticipant, async (req, res) => {
  try {
    await expireOldBookings();
    const id = safeObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Booking id không hợp lệ.' });
    const doc = await db.collection('bookings').findOne({ _id: id });
    if (!doc) return res.status(404).json({ message: 'Không tìm thấy chuyến.' });
    return res.json(serializeBooking(doc));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/bookings/:id/accept', requireApprovedDriver, async (req, res) => {
  try {
    const id = safeObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Booking id không hợp lệ.' });
    const driverPhone = req.auth.user.phone;
    let found = await findDriverByPhone(driverPhone);
    if (!found && DEMO_RUNTIME_ENABLED && driverPhone === '0909000001') found = await ensureDemoDriver();
    if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
    if (found.driver.approvalStatus !== 'APPROVED' || found.driver.kycStatus !== 'APPROVED') {
      return res.status(403).json({ message: 'Tài xế chưa được duyệt đầy đủ KYC.' });
    }
    if (!matching) return res.status(503).json({ message: 'Matching Engine chưa sẵn sàng.' });

    const validation = await matching.validateActiveOffer(id, found.driver._id);
    if (!validation.ok) return res.status(409).json({ message: validation.message });

    const claimed = await matching.claimDriverForBooking(found.driver._id, id);
    if (!claimed) {
      return res.status(409).json({ message: 'Tài xế không còn rảnh hoặc cuốc đã được chuyển.' });
    }

    const changedAt = now();
    const result = await db.collection('bookings').findOneAndUpdate(
      { _id: id, status: 'SEARCHING', driverId: null },
      { $set: {
        status: 'DRIVER_ASSIGNED',
        driverId: found.driver._id,
        vehicleId: found.vehicle?._id || null,
        driverSnapshot: {
          fullName: found.user.fullName,
          phone: found.user.phone,
          rating: Number(found.driver.rating || 5),
          vehiclePlate: found.vehicle?.plateNumber || '',
          vehicleBrand: found.vehicle?.brand || '',
          vehicleModel: found.vehicle?.model || '',
          vehicleColor: found.vehicle?.color || '',
        },
        assignedAt: changedAt,
        updatedAt: changedAt,
        'dispatch.status': 'ASSIGNED',
        'dispatch.assignedAt': changedAt,
      } },
      { returnDocument: 'after' },
    );
    const doc = result && result._id ? result : result?.value;
    if (!doc) {
      await matching.rollbackDriverClaim(found.driver._id, id);
      return res.status(409).json({ message: 'Chuyến đã được tài xế khác nhận hoặc không còn khả dụng.' });
    }

    await addEvent(id, 'DRIVER_ACCEPTED', 'DRIVER', found.driver._id, { status: 'DRIVER_ASSIGNED' });
    await matching.onBookingAccepted(doc, found.driver._id);
    return res.json(serializeBooking(doc));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: error.message });
  }
});

app.post('/api/bookings/:id/status', requireAssignedDriver, async (req, res) => {
  try {
    const id = safeObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Booking id không hợp lệ.' });
    const nextStatus = String(req.body?.status || '').toUpperCase();
    const transitions = {
      DRIVER_ASSIGNED: 'DRIVER_ARRIVING',
      DRIVER_ARRIVING: 'DRIVER_ARRIVED',
      DRIVER_ARRIVED: 'IN_PROGRESS',
      IN_PROGRESS: 'COMPLETED',
    };

    const current = await db.collection('bookings').findOne({ _id: id });
    if (!current) return res.status(404).json({ message: 'Không tìm thấy chuyến.' });
    // Idempotent completion: if the client completed the trip successfully but
    // lost the HTTP response, a retry must return the completed booking instead
    // of showing a false error to the driver.
    if (current.status === 'COMPLETED' && nextStatus === 'COMPLETED') {
      try { await platformService?.reconcileCompletedBookingSettlement(current); } catch (e) { console.error('[APP SETTLEMENT RETRY]', e.message); }
      try { await productionService?.postSettlement(current); } catch (e) { console.error('[PLATFORM_LEDGER RETRY]', e.message); }
      const refreshed = await db.collection('bookings').findOne({ _id: id });
      return res.json(serializeBooking(refreshed || current));
    }
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(current.status)) {
      return res.status(409).json({ message: 'Chuyến đã kết thúc, bị hủy hoặc hết hạn.' });
    }
    const expected = transitions[current.status];
    if (!expected || expected !== nextStatus) {
      return res.status(409).json({ message: `Không thể chuyển từ ${current.status} sang ${nextStatus}.` });
    }

    const changedAt = now();
    const patch = { status: nextStatus, updatedAt: changedAt };
    if (nextStatus === 'DRIVER_ARRIVING') patch.driverDepartedAt = changedAt;
    if (nextStatus === 'DRIVER_ARRIVED') patch.driverArrivedAt = changedAt;
    if (nextStatus === 'IN_PROGRESS') patch.startedAt = changedAt;
    if (nextStatus === 'COMPLETED') patch.completedAt = changedAt;

    let doc;
    if (nextStatus === 'COMPLETED') {
      doc = await platformService.completeBookingTransaction({
        bookingId: id,
        expectedStatus: current.status,
        changedAt,
      });
    } else {
      const result = await db.collection('bookings').findOneAndUpdate(
        { _id: id, status: current.status },
        { $set: patch },
        { returnDocument: 'after' },
      );
      doc = result && result._id ? result : result?.value;
      if (!doc) return res.status(409).json({ message: 'Trạng thái chuyến vừa thay đổi trên thiết bị khác.' });
    }

    await addEvent(id, `STATUS_${nextStatus}`, 'DRIVER', doc.driverId || null, { fromStatus: current.status, status: nextStatus });

    const statusPush = {
      DRIVER_ARRIVING: ['Tài xế đang đến', 'Tài xế đang di chuyển đến điểm đón của bạn.'],
      DRIVER_ARRIVED: ['Tài xế đã đến', 'Tài xế đã đến điểm đón. Bạn vui lòng chuẩn bị lên xe.'],
      IN_PROGRESS: ['Chuyến đã bắt đầu', 'Chuyến iMove của bạn đã bắt đầu.'],
      COMPLETED: ['Chuyến đã hoàn thành', 'Cảm ơn bạn đã sử dụng TH79 iMove.'],
    }[nextStatus];
    if (statusPush && notificationService && doc.customerId) {
      await notificationService.enqueue({
        dedupeKey: `BOOKING_STATUS:${id}:${nextStatus}`,
        type: nextStatus === 'COMPLETED' ? 'TRIP_COMPLETED' : nextStatus,
        targetType: 'CUSTOMER',
        targetId: doc.customerId,
        bookingId: id,
        title: statusPush[0],
        body: statusPush[1],
        data: { bookingId: String(id), status: nextStatus },
      }).catch((e) => console.error('[V6.9 Status Push]', e.message));
    }

    if (nextStatus === 'COMPLETED') {
      // Core trip completion is already committed. Settlement failures are
      // isolated and retriable; they must never roll back a completed trip.
      try {
        const appSettlement = await platformService?.reconcileCompletedBookingSettlement(doc);
        if (appSettlement && appSettlement.status !== 'SETTLED') {
          console.warn('[APP SETTLEMENT]', JSON.stringify(appSettlement));
        }
      } catch (settlementError) {
        console.error('[APP SETTLEMENT]', settlementError?.settlementStage || 'APP_SETTLEMENT', settlementError.message);
      }
      try {
        await productionService?.postSettlement(doc);
      } catch (settlementError) {
        console.error('[PLATFORM_LEDGER]', settlementError.message);
      }
      // Send the authoritative COMPLETED state before closing dispatch/socket
      // resources so User/Admin can update immediately from MongoDB truth.
      try { matching?.emitBookingUpdate(doc); } catch (_) {}
      // Realtime cleanup must never turn a successful completion into HTTP 500.
      try {
        await matching?.onBookingTerminal(doc);
        await dispatchEngine?.cancelBooking(doc._id, 'BOOKING_TERMINAL');
      } catch (cleanupError) {
        console.error('[Booking Complete Cleanup]', cleanupError.message);
      }
    } else {
      matching?.emitBookingUpdate(doc);
    }
    return res.json(serializeBooking(doc));
  } catch (error) {
    const status = Number(error?.httpStatus || 500);
    if (Number(error?.code) === 121 || String(error?.message || '').includes('Document failed validation')) {
      console.error('[BOOKING STATUS VALIDATION ERROR]', JSON.stringify({
        bookingId: req.params.id,
        requestedStatus: req.body?.status,
        code: error?.code,
        message: error?.message,
        errInfo: error?.errInfo || null,
      }, null, 2));
      const completionStep = error?.completionStep || 'BOOKING_VALIDATION';
      const validationCollection = error?.validationCollection || completionCollectionForStep(completionStep);
      const validationInfo = validationDetails(error);
      return res.status(500).json({
        code: 'MONGO_VALIDATION_FAILED',
        completionStep,
        validationCollection,
        validationDetails: validationInfo,
        message: `MongoDB từ chối bước ${completionStep}${validationCollection ? ` tại ${validationCollection}` : ''}. Hãy xem log [COMPLETE BOOKING VALIDATION] của Backend 1.6.0.`,
      });
    }
    return res.status(status).json({ code: error?.code || null, message: error.message });
  }
});

app.post('/api/bookings/:id/cancel', requireCancelParticipant, async (req, res) => {
  try {
    const id = safeObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Booking id không hợp lệ.' });

    const current = await db.collection('bookings').findOne({ _id: id });
    if (!current) return res.status(404).json({ message: 'Không tìm thấy chuyến.' });

    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(current.status)) {
      return res.status(409).json({
        message: 'Không thể hủy chuyến ở trạng thái hiện tại.',
      });
    }

    if (current.status === 'IN_PROGRESS') {
      return res.status(409).json({
        message: 'Chuyến đã bắt đầu. Vui lòng liên hệ hỗ trợ để xử lý.',
      });
    }

    const actorType = req.auth.role === 'DRIVER' ? 'DRIVER' : 'CUSTOMER';
    const reason = String(req.body?.reason || 'OTHER');
    const changedAt = now();

    // V5.8.2:
    // Driver hủy trước khi bắt đầu chuyến KHÔNG hủy booking của khách.
    // Booking quay lại SEARCHING và matching ngay tài xế kế tiếp.
    if (actorType === 'DRIVER') {
      const driverPhone = req.auth.user.phone;
      const found = await findDriverByPhone(driverPhone);

      if (
        !found
        || !current.driverId
        || String(found.driver._id) !== String(current.driverId)
      ) {
        return res.status(403).json({
          message: 'Tài xế không có quyền hủy chuyến này.',
        });
      }

      if (!matching) {
        return res.status(503).json({
          message: 'Matching Engine chưa sẵn sàng.',
        });
      }

      if (trustService) await trustService.analyzeCancellation({ booking: current, actorType: 'DRIVER', driverId: found.driver._id, driverUserId: found.user._id, reason });
      const requeued = await matching.requeueAfterDriverCancel(
        current,
        found.driver._id,
        reason,
      );

      await db.collection('drivers').updateOne(
        { _id: found.driver._id },
        { $inc: { cancelledTrips: 1 } },
      );

      if (notificationService && requeued.customerId) {
        await notificationService.enqueue({
          dedupeKey: `DRIVER_CANCEL_REQUEUE:${requeued._id}:${found.driver._id}:${Date.now()}`,
          type: 'BOOKING_REASSIGNING',
          targetType: 'CUSTOMER',
          targetId: requeued.customerId,
          bookingId: requeued._id,
          title: 'Đang tìm tài xế khác',
          body: 'Tài xế trước không thể tiếp tục. iMove đang ưu tiên tìm tài xế khác cho bạn.',
          data: { bookingId: String(requeued._id), status: 'SEARCHING' },
        }).catch(() => {});
      }

      const payload = serializeBooking(requeued);
      payload.reassigned = true;
      payload.message = 'Đã trả chuyến về hệ thống để tìm tài xế khác.';
      return res.json(payload);
    }

    // Khách hàng hủy thì chuyến mới thực sự kết thúc.
    if (trustService) await trustService.analyzeCancellation({ booking: current, actorType: 'CUSTOMER', driverId: current.driverId, reason });
    const result = await db.collection('bookings').findOneAndUpdate(
      { _id: id, status: current.status },
      {
        $set: {
          status: 'CANCELLED',
          cancellation: {
            actorType: 'CUSTOMER',
            reason,
            cancelledAt: changedAt,
          },
          cancelledAt: changedAt,
          updatedAt: changedAt,
        },
      },
      { returnDocument: 'after' },
    );

    const doc = result && result._id ? result : result?.value;
    if (!doc) {
      return res.status(409).json({
        message: 'Trạng thái chuyến vừa thay đổi. Hãy thử lại.',
      });
    }

    if (doc.driverId) {
      await setDriverAvailable(doc.driverId);
    }

    await addEvent(
      id,
      'CANCELLED_BY_USER',
      'CUSTOMER',
      current.customerId,
      { reason, status: 'CANCELLED' },
    );

    if (notificationService && doc.driverId) {
      await notificationService.enqueue({
        dedupeKey: `BOOKING_CANCELLED:${doc._id}:${doc.driverId}`,
        type: 'BOOKING_CANCELLED',
        targetType: 'DRIVER',
        targetId: doc.driverId,
        bookingId: doc._id,
        title: 'Khách đã hủy chuyến',
        body: 'Chuyến vừa được khách hàng hủy. Bạn có thể tiếp tục nhận chuyến khác.',
        data: { bookingId: String(doc._id), status: 'CANCELLED' },
      }).catch(() => {});
    }
    await matching?.onBookingTerminal(doc);
    await dispatchEngine?.cancelBooking(doc._id, 'BOOKING_TERMINAL');
    return res.json(serializeBooking(doc));
  } catch (error) {
    const status = [
      'REQUEUE_NOT_ALLOWED',
      'DRIVER_NOT_ASSIGNED',
      'REQUEUE_RACE',
    ].includes(error.code)
      ? 409
      : 500;

    return res.status(status).json({
      code: error.code || null,
      message: error.message,
    });
  }
});

app.get('/api/customers/:phone/bookings', requireCustomer, async (req, res) => {
  try {
    const user = req.auth.user;
    if (!user) return res.json([]);
    const docs = await db.collection('bookings').find({ customerId: user._id }).sort({ createdAt: -1 }).limit(100).toArray();
    return res.json(docs.map(serializeBooking));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});


// Admin Console API is merged directly into the Core Backend.
// This removes the separate Admin Gateway :5060 and lets the Vercel Admin call
// https://backendimove.daututh79.com/api/... directly without any Nginx changes.
const adminConsoleRouter = createAdminConsoleRouter({
  getDb: () => db,
  appVersion: APP_VERSION,
  backendUrl: String(process.env.CORE_PUBLIC_URL || 'https://backendimove.daututh79.com'),
});
app.use(adminConsoleRouter);


async function connectMongo() {
  if (connecting || mongoConnected) return;
  connecting = true;
  clearTimeout(retryTimer);

  if (!MONGODB_URI || MONGODB_URI.includes('YOUR_CLUSTER') || MONGODB_URI.includes('YOUR_URL_ENCODED_PASSWORD')) {
    lastMongoError = 'MONGODB_URI chưa được cấu hình trong file .env';
    console.error('[MongoDB Atlas]', lastMongoError);
    connecting = false;
    retryTimer = setTimeout(connectMongo, RETRY_MS);
    return;
  }

  try {
    if (mongoClient) { try { await mongoClient.close(); } catch (_) {} }
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      maxPoolSize: 20,
    });
    await mongoClient.connect();
    const nextDb = mongoClient.db(DB_NAME);
    const pong = await nextDb.command({ ping: 1 });
    if (pong.ok !== 1) throw new Error('MongoDB ping thất bại');
    db = nextDb;
    if (DB_REPAIR_ON_START) {
      console.log('[DB REPAIR] Kiểm tra dữ liệu legacy + validator trước khi mở Backend...');
      await repairDatabase({ db: nextDb, client: mongoClient, logger: console });
    } else {
      console.log('[DB REPAIR] Bỏ qua auto-repair khi startup (DB_REPAIR_ON_START=false).');
    }
    await adminConsoleRouter.ensureAdminRbacSeed();
    console.log('[Admin Console] RBAC routes + indexes READY (merged into Core).');
    mongoConnected = true;
    lastMongoError = null;
    if (String(process.env.NODE_ENV || 'development').toLowerCase() !== 'production' &&
        String(process.env.SEED_DEMO_ON_START || 'false').toLowerCase() === 'true') {
      await ensureDemoDriver();
    }
    if (matching) await matching.databaseReady();
    if (platformService) await platformService.databaseReady();
    if (notificationService) await notificationService.databaseReady();
    if (dispatchEngine) await dispatchEngine.databaseReady();
    if (trustService) await trustService.databaseReady();
    if (productionService) await productionService.databaseReady();
    console.log(`[MongoDB Atlas] CONNECTED -> ${DB_NAME}`);
  } catch (error) {
    db = null;
    mongoConnected = false;
    lastMongoError = error.message;
    console.error('[MongoDB Atlas] CONNECTION FAILED:', error.message);
    console.error(`[MongoDB Atlas] Thử lại sau ${RETRY_MS / 1000}s...`);
    retryTimer = setTimeout(connectMongo, RETRY_MS);
  } finally {
    connecting = false;
  }
}

let discoveryService = null;
let registryService = null;

const server = app.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(` TH79 iMove Core Backend ${APP_VERSION}`);
  console.log('======================================================');
  console.log(`Environment      : ${NODE_ENV}`);
  console.log(`Listen           : http://${HOST}:${PORT}`);
  console.log(`Liveness         : http://127.0.0.1:${PORT}/live`);
  console.log(`Health           : http://127.0.0.1:${PORT}/health`);
  console.log(`Readiness        : http://127.0.0.1:${PORT}/ready`);
  console.log(`Public URL       : ${String(process.env.CORE_PUBLIC_URL || '(chưa cấu hình)').trim()}`);
  console.log(`Database         : ${DB_NAME}`);
  console.log(`Mongo configured : ${MONGODB_URI ? 'YES' : 'NO'}`);

  const discoveryPort = Number(process.env.LAN_DISCOVERY_PORT || 5051);
  if (LAN_DISCOVERY_ENABLED) {
    discoveryService = startLanDiscovery({ httpPort: PORT, discoveryPort });
    const lanAddresses = getLanAddresses();
    for (const item of lanAddresses) console.log(`LAN Backend      : http://${item.address}:${PORT}`);
  } else {
    console.log('LAN Discovery    : DISABLED');
  }

  if (SERVICE_REGISTRY_ENABLED) {
    registryService = startServiceRegistry({
      getDb: () => db,
      httpPort: PORT,
      discoveryPort,
    });
    console.log('Service Registry : ENABLED');
  } else {
    console.log('Service Registry : DISABLED');
  }
  console.log('======================================================');
});

server.keepAliveTimeout = Math.max(65000, Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000));
server.headersTimeout = Math.max(server.keepAliveTimeout + 1000, Number(process.env.HEADERS_TIMEOUT_MS || 66000));
server.requestTimeout = Math.max(30000, Number(process.env.REQUEST_TIMEOUT_MS || 120000));
server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[HTTP] Port ${PORT} đang được sử dụng. Kiểm tra PM2/process cũ trước khi chạy lại.`);
  } else {
    console.error('[HTTP] Server error:', error);
  }
});

matching = createMatchingEngine({
  server,
  getDb: () => db,
  serializeBooking,
  addEvent,
});
matching.start();
notificationService = createNotificationService({ getDb: () => db });
dispatchEngine = createDispatchEngine({
  getDb: () => db,
  getClient: () => mongoClient,
  getMatching: () => matching,
  notificationService: notificationService,
  serializeBooking,
  addEvent,
});
trustService = createTrustService({ getDb: () => db, notificationService: notificationService });
productionService.startRedis().catch((e) => console.error('[V7.3 Redis]', e.message));
notificationService.start();
dispatchEngine.start();
commerceDispatchWorker = createCommerceDispatchWorker({
  getDb: () => db,
  getNotifications: () => notificationService,
  intervalMs: Number(process.env.COMMERCE_DISPATCH_INTERVAL_MS || 10000),
});
commerceDispatchWorker.start();

connectMongo();

let shuttingDown = false;
async function shutdown(signal = 'SIGTERM', exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${signal} - đang đóng dịch vụ...`);
  clearTimeout(retryTimer);
  try { discoveryService?.close(); } catch (_) {}
  try { registryService?.close(); } catch (_) {}
  try { commerceDispatchWorker?.close(); } catch (_) {}
  try { dispatchEngine?.close(); } catch (_) {}
  try { notificationService?.close(); } catch (_) {}
  try { matching?.close(); } catch (_) {}
  try { await productionService?.close(); } catch (_) {}
  try { if (mongoClient) await mongoClient.close(); } catch (_) {}

  const forceTimer = setTimeout(() => {
    try { server.closeAllConnections?.(); } catch (_) {}
    process.exit(exitCode || 1);
  }, 10000);
  forceTimer.unref?.();

  server.close(() => {
    clearTimeout(forceTimer);
    process.exit(exitCode);
  });
}
process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('unhandledRejection', (error) => {
  console.error('[Process] Unhandled rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught exception:', error);
  shutdown('uncaughtException', 1).catch(() => process.exit(1));
});


