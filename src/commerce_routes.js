const express = require('express');
const { ObjectId } = require('mongodb');
const { createAuthenticate } = require('./auth_routes');
const { createAdminGuard } = require('./admin_guard');

const ORDER_STATUSES = [
  'CREATED','WAITING_MERCHANT','MERCHANT_ACCEPTED','PREPARING','READY_FOR_PICKUP',
  'DRIVER_ASSIGNED','DRIVER_AT_MERCHANT','PICKED_UP','DELIVERING','DELIVERED','COMPLETED','CANCELLED'
];
const MERCHANT_TRANSITIONS = {
  WAITING_MERCHANT: ['MERCHANT_ACCEPTED','CANCELLED'],
  MERCHANT_ACCEPTED: ['PREPARING','READY_FOR_PICKUP','CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP','CANCELLED'],
  READY_FOR_PICKUP: ['DRIVER_ASSIGNED','DRIVER_AT_MERCHANT','PICKED_UP'],
  DRIVER_ASSIGNED: ['DRIVER_AT_MERCHANT','PICKED_UP'],
  DRIVER_AT_MERCHANT: ['PICKED_UP'],
};

const DEFAULT_DELIVERY_POLICY = {
  standard: { mode:'FIXED', value:0 },
  priority: { mode:'PERCENT', value:20 },
  fragile: { mode:'FIXED', value:10000 },
  cod: { enabled:false, requireKyc:true },
};
function normalizeFeeRule(value, fallback){
  const mode=String(value?.mode||fallback.mode||'FIXED').toUpperCase();
  return {mode:['FIXED','PERCENT'].includes(mode)?mode:'FIXED',value:Math.max(0,Number(value?.value??fallback.value??0)||0)};
}
function feeFromRule(base, rule){return rule.mode==='PERCENT'?Math.round(base*Number(rule.value||0)/100):Math.round(Number(rule.value||0));}
function normalizePreference(value){const s=String(value||'STANDARD').trim().toUpperCase();return ['PRIORITY','ƯU TIÊN','UU TIEN'].includes(s)?'PRIORITY':'STANDARD';}
function customerKycApproved(user){return ['APPROVED','VERIFIED','PASSED'].includes(String(user?.customerKycStatus||user?.kycStatus||user?.identityStatus||'').toUpperCase());}
async function getDriverPointPolicy(db){
  const policy=await db.collection('matching_policies').findOne({status:'ACTIVE'},{sort:{version:-1}}).catch(()=>null);
  return {
    blockBelow:Number(policy?.pointsPolicy?.blockBelow ?? 0),
    warnBelow:Number(policy?.pointsPolicy?.warnBelow ?? 20),
  };
}
async function getDriverPointBalance(db,driverId){
  const account=await db.collection('driver_reward_accounts').findOne({driverId});
  return Number(account?.balance ?? 0);
}
async function assertDriverPointsEligible(db,driverId){
  const [pointPolicy,pointBalance]=await Promise.all([getDriverPointPolicy(db),getDriverPointBalance(db,driverId)]);
  if(pointBalance<pointPolicy.blockBelow){
    const error=new Error(`Tài xế đang âm điểm (${pointBalance}). Cần nạp điểm trước khi nhận đơn.`);
    error.code='DRIVER_POINTS_BLOCKED';
    throw error;
  }
  return {pointBalance,pointsLow:pointBalance<=pointPolicy.warnBelow,pointPolicy};
}
async function getDeliveryPolicy(db){
  const raw=await db.collection('commerce_settings').findOne({_id:'DELIVERY_FEE_POLICY'}).catch(()=>null);
  return {
    standard:normalizeFeeRule(raw?.standard,DEFAULT_DELIVERY_POLICY.standard),
    priority:normalizeFeeRule(raw?.priority,DEFAULT_DELIVERY_POLICY.priority),
    fragile:normalizeFeeRule(raw?.fragile,DEFAULT_DELIVERY_POLICY.fragile),
    cod:{enabled:Boolean(raw?.cod?.enabled),requireKyc:raw?.cod?.requireKyc!==false},
  };
}
async function priceDeliveryExtras({db,baseFee,details,user}){
  const policy=await getDeliveryPolicy(db);
  const input=details&&typeof details==='object'?details:{};
  const preference=normalizePreference(input.deliveryPreference);
  const fragile=Boolean(input.fragile);
  const codAmount=Math.max(0,Number(input.codAmount||0));
  if(codAmount>0){
    if(!policy.cod.enabled) { const e=new Error('Thu hộ COD đang tắt trên hệ thống.');e.code='COD_DISABLED';throw e; }
    if(policy.cod.requireKyc&&!customerKycApproved(user)){const e=new Error('Thu hộ COD chỉ dành cho khách hàng đã KYC. Vui lòng hoàn tất KYC trước khi bật COD.');e.code='CUSTOMER_KYC_REQUIRED_FOR_COD';throw e;}
  }
  const preferenceRule=preference==='PRIORITY'?policy.priority:policy.standard;
  const preferenceSurcharge=feeFromRule(baseFee,preferenceRule);
  const fragileSurcharge=fragile?feeFromRule(baseFee,policy.fragile):0;
  return {policy,preference,fragile,codAmount,preferenceSurcharge,fragileSurcharge,totalSurcharge:preferenceSurcharge+fragileSurcharge,total:Math.max(0,Math.round(baseFee+preferenceSurcharge+fragileSurcharge))};
}

function oid(value) {
  try { return new ObjectId(String(value)); } catch (_) { return null; }
}
function serialize(value) {
  if (!value) return value;
  const out = { ...value };
  if (out._id) out._id = String(out._id);
  for (const key of ['merchantId','customerId','driverId','orderId','userId']) {
    if (out[key]) out[key] = String(out[key]);
  }
  return out;
}
function orderCode() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `IMF-${stamp}-${String(Date.now()).slice(-6)}`;
}
async function merchantContext(db, userId) {
  const membership = await db.collection('merchant_users').findOne({ userId });
  if (!membership) return null;
  const merchant = await db.collection('merchants').findOne({ _id: membership.merchantId });
  if (!merchant) return null;
  return { membership, merchant };
}
function createRequireMerchant(getDb) {
  const authenticate = createAuthenticate(getDb);
  return [authenticate, async (req,res,next) => {
    const roles = Array.isArray(req.auth?.user?.roles) ? req.auth.user.roles : [];
    if (!roles.includes('MERCHANT')) return res.status(403).json({ message:'Tài khoản không có quyền MERCHANT.' });
    const context = await merchantContext(getDb(), req.auth.user._id);
    if (!context) return res.status(403).json({ message:'Tài khoản chưa được gán vào cửa hàng.' });
    if (String(context.merchant.status||'ACTIVE').toUpperCase() === 'SUSPENDED') return res.status(403).json({ message:'Cửa hàng đang bị tạm khóa.' });
    req.merchantContext = context;
    next();
  }];
}


function normalizeCaps(driver) {
  const approved = Array.isArray(driver?.approvedServiceCodes)
    ? driver.approvedServiceCodes.map((x) => String(x || '').toUpperCase()).filter(Boolean)
    : [];
  if (approved.length) return approved;
  return Array.isArray(driver?.serviceCapabilities)
    ? driver.serviceCapabilities.map((x) => String(x || '').toUpperCase()).filter(Boolean)
    : [];
}

function driverCanHandleCommerce(driver, serviceCode) {
  const code = String(serviceCode || '').toUpperCase();
  const approved = Array.isArray(driver?.approvedServiceCodes)
    ? driver.approvedServiceCodes.map((x) => String(x || '').toUpperCase()).filter(Boolean)
    : [];
  const preferences = driver?.servicePreferences && typeof driver.servicePreferences === 'object'
    ? driver.servicePreferences
    : null;
  // Driver mới: approvedServiceCodes là nguồn quyền chính thức và preference phải bật.
  if (approved.length) {
    if (!approved.includes(code)) return false;
    if (preferences && preferences[code] === false) return false;
    return true;
  }
  // Driver legacy: giữ tương thích serviceCapabilities cho tới khi Admin migrate hồ sơ.
  const caps = normalizeCaps(driver);
  if (!caps.length) return true;
  if (preferences && preferences[code] === false) return false;
  if (caps.includes(code)) return true;
  if (['FOOD','ERRAND','DELIVERY'].includes(code) && caps.includes('BIKE')) return true;
  if (['FOOD','ERRAND'].includes(code) && caps.includes('DELIVERY')) return true;
  return false;
}

async function eligibleCommerceDrivers(db, serviceCode, { onlineOnly = true } = {}) {
  const query = {
    approvalStatus: 'APPROVED',
    kycStatus: 'APPROVED',
    $and: [
      { $or: [{ activeBookingId: null }, { activeBookingId: { $exists: false } }] },
      { $or: [{ activeCommerceOrderId: null }, { activeCommerceOrderId: { $exists: false } }] },
    ],
  };
  if (onlineOnly) query.onlineStatus = 'ONLINE';

  const drivers = await db.collection('drivers').find(query).limit(500).toArray();
  const capable = drivers.filter((d) => driverCanHandleCommerce(d, serviceCode));
  const driverIds = capable.map((d) => d._id).filter(Boolean);
  const userIds = capable.map((d) => d.userId).filter(Boolean);
  const [users, accounts, pointPolicy] = await Promise.all([
    userIds.length
      ? db.collection('users').find({ _id: { $in: userIds } }).project({ fullName:1, phone:1 }).toArray()
      : [],
    driverIds.length
      ? db.collection('driver_reward_accounts').find({ driverId: { $in: driverIds } }).project({driverId:1,balance:1}).toArray()
      : [],
    getDriverPointPolicy(db),
  ]);
  const byUserId = new Map(users.map((u) => [String(u._id), u]));
  const byDriverId = new Map(accounts.map((a) => [String(a.driverId), Number(a.balance || 0)]));

  return capable.map((d) => {
    const u = byUserId.get(String(d.userId)) || {};
    const pointBalance=Number(byDriverId.get(String(d._id)) ?? 0);
    return {
      ...d,
      fullName: d.fullName || d.name || u.fullName || 'Tài xế',
      phone: d.phone || u.phone || '',
      pointBalance,
      pointStatus: pointBalance < pointPolicy.blockBelow ? 'BLOCKED' : (pointBalance <= pointPolicy.warnBelow ? 'LOW' : 'OK'),
      pointWarning: pointBalance < pointPolicy.blockBelow
        ? `Số dư điểm ${pointBalance}. Tài xế cần nạp điểm trước khi nhận đơn.`
        : (pointBalance <= pointPolicy.warnBelow ? `Số dư điểm còn ${pointBalance}. Nên nạp thêm điểm.` : null),
    };
  }).filter((d)=>d.pointBalance>=pointPolicy.blockBelow);
}

async function dispatchCommerceReady({ db, order, notificationService, actorType = 'SYSTEM', actorId = null }) {
  if (!order) return { candidates: [] };
  const candidates = await eligibleCommerceDrivers(db, order.serviceCode, { onlineOnly: true });
  const now = new Date();
  await db.collection('orders').updateOne(
    { _id: order._id },
    {
      $set: {
        dispatchStatus: candidates.length ? 'SEARCHING' : 'NO_DRIVER',
        dispatchStartedAt: now,
        dispatchCandidateCount: candidates.length,
        updatedAt: now,
      },
      $push: {
        timeline: {
          status: 'DISPATCH_STARTED', at: now, actorType, actorId,
          meta: { candidateCount: candidates.length },
        },
      },
    },
  );

  if (notificationService && candidates.length) {
    await Promise.all(candidates.map((driver) => notificationService.enqueue({
      dedupeKey: `COMMERCE:${String(order._id)}:READY:${String(driver._id)}`,
      type: 'COMMERCE_ORDER',
      targetType: 'DRIVER',
      targetId: driver._id,
      level: 2,
      title: order.serviceCode === 'FOOD' ? 'Có đơn đồ ăn sẵn sàng' : order.serviceCode === 'ERRAND' ? 'Có đơn mua hộ sẵn sàng' : 'Có đơn giao hàng mới',
      body: `${order.orderCode || 'Đơn mới'} · ${order.merchantSnapshot?.name || order.pickup?.address || 'Điểm lấy hàng'}`,
      data: { orderId: String(order._id), status: 'READY_FOR_PICKUP', serviceCode: order.serviceCode },
    }).catch(() => null)));
  }
  return { candidates };
}

async function assignCommerceDriver({ db, order, driverId, notificationService, actorType = 'ADMIN', actorId = null }) {
  const driverObjectId = oid(driverId);
  if (!driverObjectId) throw new Error('Driver ID không hợp lệ.');
  const driver = await db.collection('drivers').findOne({ _id: driverObjectId });
  if (!driver || driver.approvalStatus !== 'APPROVED' || driver.kycStatus !== 'APPROVED') throw new Error('Tài xế chưa đủ điều kiện.');
  if (driver.onlineStatus !== 'ONLINE') throw new Error('Tài xế phải ONLINE để nhận đơn.');
  if (driver.activeBookingId || driver.activeCommerceOrderId) throw new Error('Tài xế đang bận.');
  if (!driverCanHandleCommerce(driver, order.serviceCode)) throw new Error('Tài xế chưa bật dịch vụ phù hợp.');
  await assertDriverPointsEligible(db, driver._id);
  const allowed = (['FOOD','ERRAND'].includes(order.serviceCode) && order.status === 'READY_FOR_PICKUP') ||
    (order.serviceCode === 'DELIVERY' && order.status === 'CREATED') ||
    (order.serviceCode === 'ERRAND' && !order.merchantId && order.status === 'CREATED');
  if (!allowed) throw new Error(`Đơn ${order.status} chưa thể điều phối.`);

  const now = new Date();
  const changed = await db.collection('orders').updateOne(
    { _id: order._id, driverId: null, status: order.status },
    {
      $set: { driverId: driver._id, status: 'DRIVER_ASSIGNED', assignedAt: now, dispatchStatus: 'ASSIGNED', updatedAt: now },
      $push: { timeline: { status:'DRIVER_ASSIGNED', at:now, actorType, actorId, meta:{ driverId:String(driver._id) } } },
    },
  );
  if (!changed.modifiedCount) throw new Error('Đơn đã được tài xế khác nhận hoặc trạng thái vừa thay đổi.');

  await db.collection('drivers').updateOne(
    { _id: driver._id, onlineStatus:'ONLINE' },
    { $set: { onlineStatus:'BUSY', activeCommerceOrderId: order._id, updatedAt:now } },
  );

  if (notificationService) {
    await notificationService.enqueue({
      dedupeKey:`COMMERCE:${String(order._id)}:ASSIGNED:${String(driver._id)}`,
      type:'COMMERCE_ORDER', targetType:'DRIVER', targetId:driver._id, level:2,
      title:'Đơn đã được điều phối cho bạn',
      body:`${order.orderCode || 'Đơn commerce'} · Mở mục Đơn dịch vụ để xử lý.`,
      data:{orderId:String(order._id),status:'DRIVER_ASSIGNED',serviceCode:order.serviceCode},
    }).catch(()=>{});
    if (order.customerId) {
      await notificationService.enqueue({
        dedupeKey:`COMMERCE:${String(order._id)}:CUSTOMER_ASSIGNED`,
        type:'COMMERCE_ORDER', targetType:'CUSTOMER', targetId:order.customerId,
        title:'Đã có tài xế nhận đơn', body:'Tài xế đang di chuyển đến điểm lấy hàng.',
        data:{orderId:String(order._id),status:'DRIVER_ASSIGNED',serviceCode:order.serviceCode},
      }).catch(()=>{});
    }
  }
  return db.collection('orders').findOne({ _id: order._id });
}

function createCommercePublicRouter({ getDb, requireCustomer, getPricing, getNotifications }) {
  const r = express.Router();
  r.get('/merchants', async (req,res) => {
    try {
      const q = { status: { $in:['ACTIVE','OPEN','BUSY'] } };
      if (req.query.category) q.categoryCode = String(req.query.category).toUpperCase();
      if (req.query.merchantType) q.merchantType = String(req.query.merchantType).toUpperCase();
      const rows = await getDb().collection('merchants').find(q).sort({ rating:-1, name:1 }).limit(100).toArray();
      res.json({ merchants: rows.map(serialize) });
    } catch (e) { res.status(500).json({ message:e.message }); }
  });
  r.get('/merchants/:id/products', async (req,res) => {
    try {
      const merchantId = oid(req.params.id); if (!merchantId) return res.status(400).json({message:'Merchant ID không hợp lệ.'});
      const products = await getDb().collection('products').find({ merchantId, status:'ACTIVE' }).sort({categoryName:1,sortOrder:1,name:1}).toArray();
      res.json({ products: products.map(serialize) });
    } catch (e) { res.status(500).json({ message:e.message }); }
  });
  r.post('/orders/quote', requireCustomer, async (req,res) => {
    try {
      const serviceCode = String(req.body?.serviceCode||'FOOD').toUpperCase();
      if (!['FOOD','DELIVERY','ERRAND'].includes(serviceCode)) return res.status(400).json({message:'Dịch vụ commerce không hợp lệ.'});
      const distanceKm = Number(req.body?.distanceKm||0);
      const durationMinutes = Number(req.body?.durationMinutes||0);
      const pricing = await getPricing().estimateFare({serviceCode,areaCode:req.body?.areaCode||'GLOBAL',distanceKm,durationMinutes});
      if (!pricing.available) return res.status(409).json({code:'FARE_UNAVAILABLE',message:pricing.reason});
      let fare={...pricing.fareSnapshot};
      let deliveryPolicy=null;
      if(serviceCode==='DELIVERY'){
        const baseFee=Number(fare.customerTotal||fare.total||0);
        const extra=await priceDeliveryExtras({db:getDb(),baseFee,details:req.body?.deliveryDetails,user:req.auth.user});
        fare={...fare,customerTotal:extra.total,total:extra.total,deliveryExtra:{preference:extra.preference,preferenceSurcharge:extra.preferenceSurcharge,fragileSurcharge:extra.fragileSurcharge,codAmount:extra.codAmount},breakdown:{...(fare.breakdown||{}),baseDeliveryFee:baseFee,preferenceSurcharge:extra.preferenceSurcharge,fragileSurcharge:extra.fragileSurcharge}};
        deliveryPolicy={codAllowed:extra.policy.cod.enabled&&(!extra.policy.cod.requireKyc||customerKycApproved(req.auth.user)),codEnabled:extra.policy.cod.enabled,requireKyc:extra.policy.cod.requireKyc};
      }
      res.json({ fare, deliveryPolicy });
    } catch(e){res.status(400).json({message:e.message});}
  });
  r.post('/orders', requireCustomer, async (req,res) => {
    try {
      const serviceCode = String(req.body?.serviceCode||'FOOD').toUpperCase();
      if (!['FOOD','DELIVERY','ERRAND'].includes(serviceCode)) return res.status(400).json({message:'serviceCode không hợp lệ.'});
      const merchantId = req.body?.merchantId ? oid(req.body.merchantId) : null;
      if (['FOOD','ERRAND'].includes(serviceCode) && !merchantId) return res.status(400).json({message:`Đơn ${serviceCode} phải có nhà hàng/cửa hàng.`});
      const db = getDb();
      let merchant = null;
      if (merchantId) {
        merchant = await db.collection('merchants').findOne({_id:merchantId,status:{$nin:['SUSPENDED','CLOSED_PERMANENTLY']}});
        if(!merchant) return res.status(404).json({message:'Không tìm thấy cửa hàng đang hoạt động.'});
      }
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const items = [];
      let subtotal = 0;
      for (const item of rawItems) {
        const productId = oid(item.productId);
        if (!productId) continue;
        const product = await db.collection('products').findOne({_id:productId,merchantId,status:'ACTIVE'});
        if (!product) continue;
        const qty = Math.min(99,Math.max(1,Number(item.quantity||1)));
        const line = Math.round(Number(product.price||0)*qty);
        subtotal += line;
        items.push({productId:product._id,name:product.name,unitPrice:Number(product.price||0),quantity:qty,lineTotal:line});
      }
      if (['FOOD','ERRAND'].includes(serviceCode) && !items.length) return res.status(400).json({message:'Giỏ hàng chưa có sản phẩm hợp lệ.'});
      const distanceKm = Number(req.body?.distanceKm||0);
      const durationMinutes = Number(req.body?.durationMinutes||0);
      const pricing = await getPricing().estimateFare({serviceCode,areaCode:req.body?.areaCode||'GLOBAL',distanceKm,durationMinutes});
      if (!pricing.available) return res.status(409).json({code:'FARE_UNAVAILABLE',message:pricing.reason});
      const baseDeliveryFee = Number(pricing.fareSnapshot?.customerTotal||pricing.fareSnapshot?.total||0);
      const deliveryExtra = serviceCode==='DELIVERY'
        ? await priceDeliveryExtras({db,baseFee:baseDeliveryFee,details:req.body?.deliveryDetails,user:req.auth.user})
        : {total:baseDeliveryFee,preference:'STANDARD',preferenceSurcharge:0,fragileSurcharge:0,codAmount:0};
      const deliveryFee = Number(deliveryExtra.total||0);
      const fareSnapshot={...pricing.fareSnapshot,customerTotal:deliveryFee,total:deliveryFee,deliveryExtra:{preference:deliveryExtra.preference,preferenceSurcharge:deliveryExtra.preferenceSurcharge,fragileSurcharge:deliveryExtra.fragileSurcharge,codAmount:deliveryExtra.codAmount},breakdown:{...(pricing.fareSnapshot?.breakdown||{}),baseDeliveryFee,preferenceSurcharge:deliveryExtra.preferenceSurcharge,fragileSurcharge:deliveryExtra.fragileSurcharge}};
      const now = new Date();
      const doc = {
        orderCode:orderCode(),serviceCode,customerId:req.auth.user._id,merchantId,driverId:null,
        status:merchantId?'WAITING_MERCHANT':'CREATED',items,subtotal,deliveryFee,
        serviceFee:Number(req.body?.serviceFee||0),discount:Number(req.body?.discount||0),
        total:Math.max(0,subtotal+deliveryFee+Number(req.body?.serviceFee||0)-Number(req.body?.discount||0)),
        fareSnapshot,
        pickup:req.body?.pickup||null,destination:req.body?.destination||null,
        customerNote:String(req.body?.customerNote||'').slice(0,500),paymentMethod:String(req.body?.paymentMethod||'CASH').toUpperCase(),paymentStatus:'UNPAID',
        deliveryDetails:req.body?.deliveryDetails && typeof req.body.deliveryDetails==='object' ? req.body.deliveryDetails : null,
        commerceDetails:req.body?.commerceDetails && typeof req.body.commerceDetails==='object' ? req.body.commerceDetails : null,
        merchantSnapshot:merchant?{name:merchant.name,address:merchant.address,location:merchant.location||null}:null,
        customerSnapshot:{fullName:req.auth.user.fullName,phone:req.auth.user.phone},
        timeline:[{status:merchantId?'WAITING_MERCHANT':'CREATED',at:now,actorType:'CUSTOMER',actorId:req.auth.user._id}],
        createdAt:now,updatedAt:now,
      };
      const result = await db.collection('orders').insertOne(doc); doc._id=result.insertedId;
      // DELIVERY does not wait for merchant approval: dispatch automatically as soon as the order exists.
      if(!merchantId && ['DELIVERY','ERRAND'].includes(serviceCode)){
        setImmediate(()=>dispatchCommerceReady({db,order:doc,notificationService:getNotifications?getNotifications():null,actorType:'SYSTEM'}).catch((error)=>console.error('[COMMERCE AUTO DISPATCH]',error.message)));
      }
      res.status(201).json({order:serialize(doc),autoDispatch:!merchantId});
    } catch(e){res.status(400).json({message:e.message});}
  });
  r.get('/orders', requireCustomer, async (req,res) => {
    try { const rows=await getDb().collection('orders').find({customerId:req.auth.user._id}).sort({createdAt:-1}).limit(100).toArray();res.json({orders:rows.map(serialize)}); }
    catch(e){res.status(500).json({message:e.message});}
  });
  return r;
}

function createMerchantRouter({ getDb, getNotifications }) {
  const r = express.Router();
  r.use(...createRequireMerchant(getDb));
  r.get('/me', (req,res)=>res.json({user:serialize(req.auth.user),membership:serialize(req.merchantContext.membership),merchant:serialize(req.merchantContext.merchant)}));
  r.get('/dashboard', async (req,res)=>{
    try{
      const db=getDb(), merchantId=req.merchantContext.merchant._id;
      const start=new Date();start.setHours(0,0,0,0);
      const [newOrders,preparing,ready,completed,todayAgg]=await Promise.all([
        db.collection('orders').countDocuments({merchantId,status:'WAITING_MERCHANT'}),
        db.collection('orders').countDocuments({merchantId,status:{$in:['MERCHANT_ACCEPTED','PREPARING']}}),
        db.collection('orders').countDocuments({merchantId,status:'READY_FOR_PICKUP'}),
        db.collection('orders').countDocuments({merchantId,status:{$in:['DELIVERED','COMPLETED']},updatedAt:{$gte:start}}),
        db.collection('orders').aggregate([{$match:{merchantId,status:{$in:['DELIVERED','COMPLETED']},updatedAt:{$gte:start}}},{$group:{_id:null,gross:{$sum:'$subtotal'},orders:{$sum:1}}}]).toArray(),
      ]);
      res.json({newOrders,preparing,ready,completedToday:completed,grossToday:todayAgg[0]?.gross||0,orderCountToday:todayAgg[0]?.orders||0,merchant:serialize(req.merchantContext.merchant)});
    }catch(e){res.status(500).json({message:e.message});}
  });
  r.get('/orders', async (req,res)=>{
    try{const q={merchantId:req.merchantContext.merchant._id};if(req.query.status)q.status=String(req.query.status).toUpperCase();const rows=await getDb().collection('orders').find(q).sort({createdAt:-1}).limit(200).toArray();res.json({orders:rows.map(serialize)});}catch(e){res.status(500).json({message:e.message});}
  });
  r.put('/orders/:id/status', async (req,res)=>{
    try{
      const db=getDb(),_id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});
      const current=await db.collection('orders').findOne({_id,merchantId:req.merchantContext.merchant._id});if(!current)return res.status(404).json({message:'Không tìm thấy đơn.'});
      const next=String(req.body?.status||'').toUpperCase();
      if(!ORDER_STATUSES.includes(next))return res.status(400).json({message:'Trạng thái không hợp lệ.'});
      const allowed=MERCHANT_TRANSITIONS[current.status]||[];
      if(!allowed.includes(next))return res.status(409).json({message:`Merchant không thể chuyển ${current.status} → ${next}.`});
      const now=new Date();
      await db.collection('orders').updateOne({_id},{$set:{status:next,updatedAt:now,...(next==='READY_FOR_PICKUP'?{readyAt:now}:{}),...(next==='CANCELLED'?{cancelledAt:now,cancelReason:String(req.body?.reason||'MERCHANT_CANCELLED')}: {})},$push:{timeline:{status:next,at:now,actorType:'MERCHANT',actorId:req.auth.user._id}}});
      const updatedOrder=await db.collection('orders').findOne({_id});
      if(next==='READY_FOR_PICKUP' && updatedOrder){
        await dispatchCommerceReady({
          db, order:updatedOrder,
          notificationService:getNotifications?getNotifications():null,
          actorType:'MERCHANT', actorId:req.auth.user._id,
        });
      }
      if(getNotifications && updatedOrder?.customerId){
        const labels={MERCHANT_ACCEPTED:['Cửa hàng đã xác nhận','Đơn hàng của bạn đã được cửa hàng xác nhận.'],PREPARING:['Đang chuẩn bị','Cửa hàng đang chuẩn bị đơn hàng của bạn.'],READY_FOR_PICKUP:['Sẵn sàng lấy hàng','Đơn đã sẵn sàng để tài xế đến nhận.'],CANCELLED:['Đơn đã bị hủy','Cửa hàng không thể tiếp tục xử lý đơn này.']};
        const msg=labels[next];
        if(msg) await getNotifications().enqueue({dedupeKey:`ORDER:${String(_id)}:${next}`,type:'COMMERCE_ORDER',targetType:'CUSTOMER',targetId:updatedOrder.customerId,title:msg[0],body:msg[1],data:{orderId:String(_id),status:next,serviceCode:updatedOrder.serviceCode}}).catch(()=>{});
      }
      res.json({order:serialize(updatedOrder)});
    }catch(e){res.status(400).json({message:e.message});}
  });
  r.get('/products', async (req,res)=>{try{const rows=await getDb().collection('products').find({merchantId:req.merchantContext.merchant._id}).sort({categoryName:1,sortOrder:1,name:1}).toArray();res.json({products:rows.map(serialize)});}catch(e){res.status(500).json({message:e.message});}});
  r.post('/products', async (req,res)=>{
    try{const now=new Date();const doc={merchantId:req.merchantContext.merchant._id,name:String(req.body?.name||'').trim(),description:String(req.body?.description||'').trim(),categoryName:String(req.body?.categoryName||'Khác').trim(),price:Math.max(0,Number(req.body?.price||0)),imageUrl:req.body?.imageUrl||null,status:String(req.body?.status||'ACTIVE').toUpperCase(),stockStatus:String(req.body?.stockStatus||'AVAILABLE').toUpperCase(),sortOrder:Number(req.body?.sortOrder||0),createdAt:now,updatedAt:now};if(doc.name.length<2)return res.status(400).json({message:'Tên sản phẩm quá ngắn.'});const x=await getDb().collection('products').insertOne(doc);doc._id=x.insertedId;res.status(201).json({product:serialize(doc)});}catch(e){res.status(400).json({message:e.message});}
  });
  r.put('/products/:id', async (req,res)=>{
    try{const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Product ID không hợp lệ.'});const patch={};for(const k of ['name','description','categoryName','imageUrl','status','stockStatus','sortOrder'])if(req.body?.[k]!==undefined)patch[k]=req.body[k];if(req.body?.price!==undefined)patch.price=Math.max(0,Number(req.body.price||0));patch.updatedAt=new Date();const x=await getDb().collection('products').updateOne({_id,merchantId:req.merchantContext.merchant._id},{$set:patch});if(!x.matchedCount)return res.status(404).json({message:'Không tìm thấy sản phẩm.'});res.json({product:serialize(await getDb().collection('products').findOne({_id}))});}catch(e){res.status(400).json({message:e.message});}
  });
  r.get('/store', (req,res)=>res.json({merchant:serialize(req.merchantContext.merchant)}));
  r.put('/store', async (req,res)=>{
    try{const patch={};for(const k of ['name','address','phone','description','status','openingHours','pickupInstruction','logoUrl','coverUrl','categoryName'])if(req.body?.[k]!==undefined)patch[k]=req.body[k];if(req.body?.merchantType!==undefined){const type=String(req.body.merchantType).toUpperCase();if(!['STORE','RESTAURANT'].includes(type))return res.status(400).json({message:'merchantType phải là STORE hoặc RESTAURANT.'});patch.merchantType=type;patch.merchantTypeLabel=type==='RESTAURANT'?'Nhà hàng · Food':'Cửa hàng · Đặt hộ';patch.categoryCode=type==='RESTAURANT'?'FOOD':'ERRAND';}patch.updatedAt=new Date();await getDb().collection('merchants').updateOne({_id:req.merchantContext.merchant._id},{$set:patch});res.json({merchant:serialize(await getDb().collection('merchants').findOne({_id:req.merchantContext.merchant._id}))});}catch(e){res.status(400).json({message:e.message});}
  });
  r.get('/settlements', async (req,res)=>{try{const rows=await getDb().collection('merchant_settlements').find({merchantId:req.merchantContext.merchant._id}).sort({periodEnd:-1,createdAt:-1}).limit(100).toArray();res.json({settlements:rows.map(serialize)});}catch(e){res.status(500).json({message:e.message});}});
  return r;
}


function createCommerceDriverRouter({ getDb, requireApprovedDriver, findDriverByPhone, getNotifications }) {
  const r=express.Router();
  r.use(requireApprovedDriver);
  async function driver(req,res){const found=await findDriverByPhone(req.auth.user.phone);if(!found){res.status(404).json({message:'Không tìm thấy tài xế.'});return null;}return found;}
  r.get('/orders/available', async (req,res)=>{
    try{
      const found=await driver(req,res);if(!found)return;
      if(found.driver.onlineStatus!=='ONLINE' || found.driver.activeBookingId || found.driver.activeCommerceOrderId){
        return res.json({orders:[]});
      }
      const pointState=await assertDriverPointsEligible(getDb(),found.driver._id).catch(()=>null);
      if(!pointState)return res.json({orders:[],pointStatus:'BLOCKED'});
      const rows=await getDb().collection('orders').find({
        driverId:null,
        $or:[
          {serviceCode:{$in:['FOOD','ERRAND']},status:'READY_FOR_PICKUP'},
          {serviceCode:'DELIVERY',status:'CREATED'},
          {serviceCode:'ERRAND',merchantId:null,status:'CREATED'},
        ],
      }).sort({readyAt:1,createdAt:1}).limit(80).toArray();
      const eligible=rows.filter((order)=>driverCanHandleCommerce(found.driver,order.serviceCode)).slice(0,30);
      res.json({orders:eligible.map(serialize)});
    }catch(e){res.status(500).json({message:e.message});}
  });
  r.get('/orders/active', async (req,res)=>{
    try{const found=await driver(req,res);if(!found)return;const row=await getDb().collection('orders').findOne({driverId:found.driver._id,status:{$in:['DRIVER_ASSIGNED','DRIVER_AT_MERCHANT','PICKED_UP','DELIVERING','DELIVERED']}},{sort:{updatedAt:-1}});res.json({order:serialize(row)});}catch(e){res.status(500).json({message:e.message});}
  });
  r.post('/orders/:id/accept', async (req,res)=>{
    try{
      const found=await driver(req,res);if(!found)return;
      const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});
      const current=await getDb().collection('orders').findOne({_id});if(!current)return res.status(404).json({message:'Không tìm thấy đơn.'});
      const allowed=([ 'FOOD','ERRAND' ].includes(current.serviceCode)&&current.status==='READY_FOR_PICKUP')||(current.serviceCode==='DELIVERY'&&current.status==='CREATED')||(current.serviceCode==='ERRAND'&&!current.merchantId&&current.status==='CREATED');
      if(!allowed)return res.status(409).json({message:'Đơn không còn sẵn sàng để nhận.'});
      if(found.driver.onlineStatus!=='ONLINE')return res.status(409).json({message:'Tài xế phải ONLINE để nhận đơn.'});
      if(found.driver.activeBookingId||found.driver.activeCommerceOrderId)return res.status(409).json({message:'Tài xế đang có chuyến/đơn hoạt động.'});
      if(!driverCanHandleCommerce(found.driver,current.serviceCode))return res.status(403).json({message:'Tài xế chưa bật loại dịch vụ phù hợp.'});
      await assertDriverPointsEligible(getDb(),found.driver._id);
      const now=new Date();
      const x=await getDb().collection('orders').updateOne({_id,driverId:null,status:current.status},{$set:{driverId:found.driver._id,status:'DRIVER_ASSIGNED',assignedAt:now,dispatchStatus:'ASSIGNED',updatedAt:now},$push:{timeline:{status:'DRIVER_ASSIGNED',at:now,actorType:'DRIVER',actorId:found.driver._id}}});
      if(!x.modifiedCount)return res.status(409).json({message:'Đơn vừa được tài xế khác nhận.'});
      await getDb().collection('drivers').updateOne({_id:found.driver._id,onlineStatus:'ONLINE'},{$set:{onlineStatus:'BUSY',activeCommerceOrderId:_id,updatedAt:now}});
      const updatedOrder=await getDb().collection('orders').findOne({_id});
      if(getNotifications&&updatedOrder?.customerId)await getNotifications().enqueue({dedupeKey:`ORDER:${String(_id)}:DRIVER_ASSIGNED`,type:'COMMERCE_ORDER',targetType:'CUSTOMER',targetId:updatedOrder.customerId,title:'Đã có tài xế nhận đơn',body:'Tài xế đang di chuyển đến điểm lấy hàng.',data:{orderId:String(_id),status:'DRIVER_ASSIGNED',serviceCode:updatedOrder.serviceCode}}).catch(()=>{});
      res.json({order:serialize(updatedOrder)});
    }catch(e){res.status(400).json({message:e.message});}
  });
  r.post('/orders/:id/status', async (req,res)=>{
    try{const found=await driver(req,res);if(!found)return;const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});const current=await getDb().collection('orders').findOne({_id,driverId:found.driver._id});if(!current)return res.status(404).json({message:'Không tìm thấy đơn của tài xế.'});const next=String(req.body?.status||'').toUpperCase();const transitions={DRIVER_ASSIGNED:['DRIVER_AT_MERCHANT','PICKED_UP'],DRIVER_AT_MERCHANT:['PICKED_UP'],PICKED_UP:['DELIVERING'],DELIVERING:['DELIVERED'],DELIVERED:['COMPLETED']};if(!(transitions[current.status]||[]).includes(next))return res.status(409).json({message:`Không thể chuyển ${current.status} → ${next}.`});const now=new Date();await getDb().collection('orders').updateOne({_id},{$set:{status:next,updatedAt:now,...(next==='PICKED_UP'?{pickedUpAt:now}:{}),...(next==='DELIVERED'?{deliveredAt:now}:{}),...(next==='COMPLETED'?{completedAt:now,paymentStatus:String(current.paymentMethod||'CASH').toUpperCase()==='CASH'?'PAID':current.paymentStatus}: {})},$push:{timeline:{status:next,at:now,actorType:'DRIVER',actorId:found.driver._id}}});const updatedOrder=await getDb().collection('orders').findOne({_id});if(next==='COMPLETED'){await getDb().collection('drivers').updateOne({_id:found.driver._id,activeCommerceOrderId:_id},{$set:{onlineStatus:'ONLINE',activeCommerceOrderId:null,updatedAt:now}});}if(getNotifications&&updatedOrder?.customerId){const labels={DRIVER_AT_MERCHANT:['Tài xế đã đến điểm lấy','Tài xế đang chờ nhận đơn của bạn.'],PICKED_UP:['Tài xế đã nhận đơn','Đơn hàng đang được chuẩn bị giao đến bạn.'],DELIVERING:['Đang giao đến bạn','Tài xế đang di chuyển đến địa chỉ nhận.'],DELIVERED:['Đã giao hàng','Đơn đã được giao.'],COMPLETED:['Đơn đã hoàn thành','Cảm ơn bạn đã sử dụng TH79 iMove.']};const msg=labels[next];if(msg)await getNotifications().enqueue({dedupeKey:`ORDER:${String(_id)}:${next}`,type:'COMMERCE_ORDER',targetType:'CUSTOMER',targetId:updatedOrder.customerId,title:msg[0],body:msg[1],data:{orderId:String(_id),status:next,serviceCode:updatedOrder.serviceCode}}).catch(()=>{});}res.json({order:serialize(updatedOrder)});}catch(e){res.status(400).json({message:e.message});}
  });
  return r;
}

function createCommerceAdminRouter({ getDb, getNotifications }) {
  const r=express.Router();const {requireAdmin,permit}=createAdminGuard({getDb});r.use(requireAdmin);
  r.get('/delivery-policy',permit('orders.view'),async(_req,res)=>{try{res.json({policy:await getDeliveryPolicy(getDb())});}catch(e){res.status(500).json({message:e.message});}});
  r.put('/delivery-policy',permit('orders.view'),async(req,res)=>{try{const db=getDb(),now=new Date();const current=await getDeliveryPolicy(db);const policy={standard:normalizeFeeRule(req.body?.standard,current.standard),priority:normalizeFeeRule(req.body?.priority,current.priority),fragile:normalizeFeeRule(req.body?.fragile,current.fragile),cod:{enabled:Boolean(req.body?.cod?.enabled),requireKyc:req.body?.cod?.requireKyc!==false},updatedAt:now,updatedBy:req.admin._id};await db.collection('commerce_settings').updateOne({_id:'DELIVERY_FEE_POLICY'},{$set:policy},{upsert:true});await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'DELIVERY_POLICY_UPDATE',entityType:'COMMERCE_SETTING',entityId:'DELIVERY_FEE_POLICY',after:policy,createdAt:now});res.json({policy});}catch(e){res.status(400).json({message:e.message});}});
  r.get('/merchants',permit('merchants.view'),async(req,res)=>{try{const rows=await getDb().collection('merchants').find({}).sort({createdAt:-1}).limit(500).toArray();res.json({merchants:rows.map(serialize)});}catch(e){res.status(500).json({message:e.message});}});
  r.put('/merchants/:id',permit('merchants.manage'),async(req,res)=>{try{const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Merchant ID không hợp lệ.'});const patch={};for(const k of ['status','name','commissionRate','categoryCode','merchantType','merchantTypeLabel','categoryName','logoUrl','coverUrl'])if(req.body?.[k]!==undefined)patch[k]=req.body[k];patch.updatedAt=new Date();await getDb().collection('merchants').updateOne({_id},{$set:patch});await getDb().collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'MERCHANT_UPDATE',entityType:'MERCHANT',entityId:String(_id),after:patch,createdAt:new Date()});res.json({merchant:serialize(await getDb().collection('merchants').findOne({_id}))});}catch(e){res.status(400).json({message:e.message});}});
  r.get('/orders',permit('orders.view'),async(req,res)=>{try{const q={};if(req.query.status)q.status=String(req.query.status).toUpperCase();if(req.query.serviceCode)q.serviceCode=String(req.query.serviceCode).toUpperCase();const rows=await getDb().collection('orders').find(q).sort({createdAt:-1}).limit(500).toArray();res.json({orders:rows.map(serialize)});}catch(e){res.status(500).json({message:e.message});}});
  r.get('/orders/:id/candidates',permit('orders.view'),async(req,res)=>{
    try{
      const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});
      const order=await getDb().collection('orders').findOne({_id});if(!order)return res.status(404).json({message:'Không tìm thấy đơn.'});
      const drivers=await eligibleCommerceDrivers(getDb(),order.serviceCode,{onlineOnly:true});
      res.json({order:serialize(order),drivers:drivers.map((d)=>({id:String(d._id),fullName:d.fullName,phone:d.phone,onlineStatus:d.onlineStatus,rating:Number(d.rating||0),completedTrips:Number(d.completedTrips||0),pointBalance:Number(d.pointBalance||0),pointStatus:d.pointStatus,pointWarning:d.pointWarning,serviceCapabilities:normalizeCaps(d)}))});
    }catch(e){res.status(500).json({message:e.message});}
  });
  // Giữ quyền orders.view để các role vận hành hiện hữu có thể điều phối commerce mà không cần migrate role thủ công.
  r.post('/orders/:id/dispatch',permit('orders.view'),async(req,res)=>{
    try{
      const db=getDb(),_id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});
      const order=await db.collection('orders').findOne({_id});if(!order)return res.status(404).json({message:'Không tìm thấy đơn.'});
      if(req.body?.driverId){
        const updated=await assignCommerceDriver({db,order,driverId:req.body.driverId,notificationService:getNotifications?getNotifications():null,actorType:'ADMIN',actorId:req.admin._id});
        await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'COMMERCE_ASSIGN_DRIVER',entityType:'ORDER',entityId:String(_id),after:{driverId:String(req.body.driverId)},createdAt:new Date()});
        return res.json({mode:'ASSIGNED',order:serialize(updated)});
      }
      const allowed=(['FOOD','ERRAND'].includes(order.serviceCode)&&order.status==='READY_FOR_PICKUP')||(order.serviceCode==='DELIVERY'&&order.status==='CREATED')||(order.serviceCode==='ERRAND'&&!order.merchantId&&order.status==='CREATED');
      if(!allowed)return res.status(409).json({message:`Đơn ${order.status} chưa sẵn sàng phát tài xế.`});
      const result=await dispatchCommerceReady({db,order,notificationService:getNotifications?getNotifications():null,actorType:'ADMIN',actorId:req.admin._id});
      await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'COMMERCE_BROADCAST_DISPATCH',entityType:'ORDER',entityId:String(_id),after:{candidateCount:result.candidates.length},createdAt:new Date()});
      res.json({mode:'BROADCAST',candidateCount:result.candidates.length});
    }catch(e){res.status(400).json({message:e.message});}
  });
  return r;
}


function createCommerceDispatchWorker({getDb,getNotifications,intervalMs=10000}){
  let timer=null,busy=false;
  async function tick(){
    const db=getDb();if(!db||busy)return;busy=true;
    try{
      const cutoff=new Date(Date.now()-5000);
      const rows=await db.collection('orders').find({driverId:null,updatedAt:{$lte:cutoff},$or:[{serviceCode:'DELIVERY',status:'CREATED'},{serviceCode:{$in:['FOOD','ERRAND']},status:'READY_FOR_PICKUP'}]}).sort({updatedAt:1}).limit(20).toArray();
      for(const order of rows){
        if(order.dispatchStatus==='SEARCHING' && order.dispatchStartedAt && Date.now()-new Date(order.dispatchStartedAt).getTime()<15000) continue;
        await dispatchCommerceReady({db,order,notificationService:getNotifications?getNotifications():null,actorType:'SYSTEM'}).catch(()=>{});
      }
    }finally{busy=false;}
  }
  return {start(){if(timer)return;timer=setInterval(tick,Math.max(5000,Number(intervalMs)||10000));timer.unref?.();setTimeout(tick,1500);},close(){if(timer)clearInterval(timer);timer=null;}};
}

module.exports={createCommercePublicRouter,createMerchantRouter,createCommerceDriverRouter,createCommerceAdminRouter,createCommerceDispatchWorker,ORDER_STATUSES};
