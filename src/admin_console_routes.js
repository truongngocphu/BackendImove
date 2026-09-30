const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId, Int32 } = require('mongodb');

const ADMIN_ALL_PERMISSIONS = [
  'dashboard.view',
  'users.view','users.update','users.block',
  'drivers.view','drivers.review','drivers.approve','drivers.suspend',
  'vehicles.view','vehicles.review',
  'bookings.view','bookings.cancel','bookings.adjust',
  'matching.view','matching.manage','matching.dispatch',
  'trust.view','trust.review','trust.manage',
  'pricing.view','pricing.create','pricing.activate','pricing.archive',
  'fees.view','fees.manage','promotions.view','promotions.manage',
  'broadcast.view','broadcast.send',
  'payments.view','payments.refund','wallets.view','wallets.adjust',
  'settlements.view','settlements.manage',
  'support.view','support.assign','support.reply','support.close',
  'settings.view','settings.manage','reports.view','audit.view',
  'admins.view','admins.manage','roles.manage',
  'services.view','services.manage','merchants.view','merchants.manage','orders.view',
  'pricing.manage','broadcast.manage'
];

const DEFAULT_ADMIN_ROLES = [
  ['SUPER_ADMIN','Quản trị tối cao',ADMIN_ALL_PERMISSIONS],
  ['OPERATIONS','Vận hành',['dashboard.view','users.view','users.update','drivers.view','drivers.review','drivers.approve','vehicles.view','vehicles.review','bookings.view','bookings.adjust','bookings.cancel','matching.view','matching.manage','matching.dispatch','trust.view','trust.review','trust.manage','broadcast.view','broadcast.send','broadcast.manage','reports.view','services.view','merchants.view','orders.view']],
  ['DRIVER_REVIEW','Duyệt tài xế',['dashboard.view','drivers.view','drivers.review','drivers.approve','drivers.suspend','vehicles.view','vehicles.review']],
  ['PRICING_MANAGER','Quản lý giá cước',['dashboard.view','pricing.view','pricing.create','pricing.activate','pricing.archive','fees.view','fees.manage','promotions.view','promotions.manage','audit.view','pricing.manage','services.view','services.manage']],
  ['FINANCE','Kế toán - tài chính',['dashboard.view','bookings.view','payments.view','payments.refund','wallets.view','wallets.adjust','settlements.view','settlements.manage','reports.view']],
  ['SUPPORT','Chăm sóc khách hàng',['dashboard.view','users.view','drivers.view','bookings.view','support.view','support.assign','support.reply','support.close']],
  ['VIEWER','Chỉ xem',['dashboard.view','users.view','drivers.view','bookings.view','pricing.view','fees.view','payments.view','reports.view','broadcast.view']]
];

function createAdminConsoleRouter({ getDb, appVersion = '1.6.1', backendUrl = 'https://backendimove.daututh79.com' } = {}) {
  if (typeof getDb !== 'function') throw new Error('createAdminConsoleRouter yêu cầu getDb().');
  const router = express.Router();
  const APP_VERSION = String(appVersion || '1.6.1');
  const CORE_BACKEND_URL = String(backendUrl || 'https://backendimove.daututh79.com').replace(/\/+$/, '');
  const DB_NAME = String(process.env.MONGODB_DB || 'th79_imove');

  const collectionMap = {
    customers: process.env.COLLECTION_CUSTOMERS || 'users',
    drivers: process.env.COLLECTION_DRIVERS || 'drivers',
    trips: process.env.COLLECTION_TRIPS || 'bookings',
    payments: process.env.COLLECTION_PAYMENTS || 'payments',
    revenue: process.env.COLLECTION_REVENUE || 'revenue'
  };
  const allowedArrayKeys = new Set(Object.keys(collectionMap));
  const defaultSettings = {
    companyName: 'Công ty TNHH Đầu tư T&H 79',
    brandName: 'TH79 iMove',
    hotline: '0335555066',
    autoAssign: true
  };

  function db() {
    const value = getDb();
    if (!value) throw new Error('MongoDB chưa sẵn sàng');
    return value;
  }
  function publicId(doc) {
    if (doc?.id !== undefined && doc?.id !== null && String(doc.id).trim()) return String(doc.id);
    return String(doc?._id || '');
  }

  function serializeDoc(doc) {
    const out = { ...doc };
    out._id = String(doc._id);
    if (!out.id) out.id = String(doc._id);
    return out;
  }

  async function getArrayData(key) {
    const collection = db().collection(collectionMap[key]);
    const filter = key === 'customers' && collectionMap.customers === 'users' ? { roles: 'CUSTOMER' } : {};
    const rows = await collection.find(filter).sort({ createdAt: -1, _id: -1 }).toArray();
    return rows.map(serializeDoc);
  }

  async function syncArrayData(key, incoming) {
    if (!Array.isArray(incoming)) throw new Error('Dữ liệu gửi lên phải là một mảng');
    const collection = db().collection(collectionMap[key]);
    const existing = await collection.find({}).toArray();
    const existingByPublicId = new Map(existing.map(doc => [publicId(doc), doc]));
    const keep = new Set();
    const operations = [];

    for (const rowRaw of incoming) {
      const row = { ...rowRaw };
      const candidate = String(row.id || row._id || new ObjectId().toString());
      keep.add(candidate);

      const existingDoc = existingByPublicId.get(candidate);
      let filter;
      if (existingDoc) filter = { _id: existingDoc._id };
      else if (ObjectId.isValid(candidate) && candidate.length === 24) filter = { _id: new ObjectId(candidate) };
      else filter = { id: candidate };

      delete row._id;
      if (!row.id) row.id = candidate;

      operations.push({
        updateOne: {
          filter,
          update: { $set: row },
          upsert: true
        }
      });
    }

    for (const doc of existing) {
      if (!keep.has(publicId(doc))) operations.push({ deleteOne: { filter: { _id: doc._id } } });
    }

    if (operations.length) await collection.bulkWrite(operations, { ordered: false });
    return getArrayData(key);
  }

  async function getSettings() {
    const doc = await db().collection('settings').findOne({ _scope: 'th79_imove_admin' });
    if (!doc) return { ...defaultSettings };
    const { _id, _scope, ...settings } = doc;
    return { ...defaultSettings, ...settings };
  }

  async function saveSettings(settings) {
    const clean = { ...settings };
    delete clean._id;
    delete clean._scope;
    await db().collection('settings').updateOne(
      { _scope: 'th79_imove_admin' },
      { $set: clean, $setOnInsert: { _scope: 'th79_imove_admin' } },
      { upsert: true }
    );
    return getSettings();
  }

  // ============================================================
  // INTERNAL ADMIN ACCOUNTS / RBAC
  // Uses the same users collection + bcrypt passwordHash consumed
  // by Core Backend /api/admin-auth/login. Granular role data lives
  // in admin_roles and is attached to users through adminRoleCodes.
  // ============================================================
  async function ensureAdminRbacSeed(){
    const roles=db().collection('admin_roles');
    await roles.createIndex({code:1},{unique:true,name:'uq_admin_roles_code'}).catch(()=>{});
    const audit=db().collection('audit_logs');
    await audit.createIndex({actorType:1,createdAt:-1},{name:'idx_audit_actor_type_created'}).catch(()=>{});
    await audit.createIndex({actorId:1,createdAt:-1},{name:'idx_audit_actor_created'}).catch(()=>{});
    await audit.createIndex({action:1,createdAt:-1},{name:'idx_audit_action_created'}).catch(()=>{});
    for(const [code,name,permissions] of DEFAULT_ADMIN_ROLES){
      const setOnInsert={code,name,permissions,status:'ACTIVE',createdAt:new Date()};
      const update=code==='SUPER_ADMIN'
        ? {$set:{name,permissions:ADMIN_ALL_PERMISSIONS,status:'ACTIVE',updatedAt:new Date()},$setOnInsert:{code,createdAt:new Date()}}
        : {$setOnInsert:setOnInsert,$set:{updatedAt:new Date()}};
      await roles.updateOne({code},update,{upsert:true});
    }
    await roles.updateOne(
      {code:'OPERATIONS'},
      {$addToSet:{permissions:{$each:['matching.view','matching.manage','matching.dispatch','trust.view','trust.review','broadcast.manage','services.view','merchants.view','orders.view']}},$set:{updatedAt:new Date()}},
    ).catch(()=>{});
    await roles.updateOne(
      {code:'PRICING_MANAGER'},
      {$addToSet:{permissions:{$each:['pricing.manage','services.view','services.manage']}},$set:{updatedAt:new Date()}},
    ).catch(()=>{});
  }

  function objectIdOrNull(value){
    const text=String(value||'');
    return ObjectId.isValid(text)?new ObjectId(text):null;
  }

  function adminRoleCodesOf(user){
    const preferred=Array.isArray(user?.adminRoleCodes)?user.adminRoleCodes:Array.isArray(user?.roleCodes)?user.roleCodes:[];
    const clean=[...new Set(preferred.map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))];
    // Backward compatibility for the legacy ADMIN created by Backend V5.3.
    // Existing admin accounts had roles:['ADMIN'] but no granular role field.
    return clean.length?clean:['SUPER_ADMIN'];
  }

  function publicInternalAdmin(user){
    return {
      _id:String(user._id),id:String(user._id),
      fullName:user.fullName||'Quản trị viên',phone:user.phone||null,email:user.email||null,
      status:user.status||'ACTIVE',roleCodes:adminRoleCodesOf(user),
      lastLoginAt:user.lastLoginAt||null,createdAt:user.createdAt||null,updatedAt:user.updatedAt||null
    };
  }

  const adminTokenCache=new Map();
  function jwtSecret(){
    const secret=String(process.env.JWT_ACCESS_SECRET||'').trim();
    if(secret.length<32){const e=new Error('JWT_ACCESS_SECRET chưa được cấu hình an toàn.');e.status=500;throw e}
    return secret;
  }
  async function resolveAdminAccess(req){
    const header=String(req.headers.authorization||'');
    if(!header.startsWith('Bearer ')){const e=new Error('Thiếu Access Token quản trị.');e.status=401;throw e}
    const token=header.slice(7).trim();
    const cached=adminTokenCache.get(token);
    if(cached&&Date.now()-cached.at<30000)return cached.access;

    let payload;
    try{payload=jwt.verify(token,jwtSecret())}
    catch(_){const e=new Error('Phiên quản trị không hợp lệ hoặc đã hết hạn.');e.status=401;throw e}
    const userId=objectIdOrNull(payload?.sub||payload?.userId);
    if(!userId){const e=new Error('Access Token quản trị không hợp lệ.');e.status=401;throw e}
    const user=await db().collection('users').findOne({_id:userId,roles:'ADMIN'});
    if(!user){const e=new Error('Không tìm thấy tài khoản ADMIN trong MongoDB.');e.status=403;throw e}
    const status=String(user.status||'ACTIVE').toUpperCase();
    if(['BLOCKED','DISABLED','DELETED','INACTIVE'].includes(status)){const e=new Error('Tài khoản quản trị đã bị khóa.');e.status=403;throw e}

    const roleCodes=adminRoleCodesOf(user);
    const roles=await db().collection('admin_roles').find({code:{$in:roleCodes},status:'ACTIVE'}).toArray();
    const permissions=roleCodes.includes('SUPER_ADMIN')
      ? [...ADMIN_ALL_PERMISSIONS]
      : [...new Set(roles.flatMap(r=>Array.isArray(r.permissions)?r.permissions:[]))];
    const roleNames=roleCodes.map(code=>roles.find(r=>r.code===code)?.name||code);
    const access={user:publicInternalAdmin(user),roleCodes,roleNames,permissions};
    adminTokenCache.set(token,{at:Date.now(),access});
    if(adminTokenCache.size>150){for(const [key,value] of adminTokenCache){if(Date.now()-value.at>60000)adminTokenCache.delete(key)}}
    return access;
  }

  function requireAdminAccess(permission){
    return async(req,res,next)=>{
      try{
        const access=await resolveAdminAccess(req);
        req.adminAccess=access;
        if(permission&&!access.permissions.includes(permission))return res.status(403).json({message:'Bạn không có quyền thực hiện thao tác này.'});
        next();
      }catch(error){res.status(error.status||500).json({message:error.message})}
    };
  }

  function requireAnyAdminAccess(permissions=[]){
    return async(req,res,next)=>{
      try{
        const access=await resolveAdminAccess(req);req.adminAccess=access;
        if(permissions.length&&!permissions.some(p=>access.permissions.includes(p)))return res.status(403).json({message:'Bạn không có quyền truy cập quản trị tài khoản.'});
        next();
      }catch(error){res.status(error.status||500).json({message:error.message})}
    };
  }

  async function validRoleCodes(codes){
    const clean=[...new Set((Array.isArray(codes)?codes:[]).map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))];
    if(!clean.length)throw new Error('Phải chọn ít nhất một vai trò.');
    const count=await db().collection('admin_roles').countDocuments({code:{$in:clean},status:'ACTIVE'});
    if(count!==clean.length)throw new Error('Có vai trò không tồn tại hoặc đang tạm ngưng.');
    return clean;
  }

  function auditSafeSnapshot(value,depth=0){
    if(value===null||value===undefined)return value;
    if(depth>5)return '[TRUNCATED]';
    if(value instanceof Date)return value;
    if(Array.isArray(value))return value.slice(0,60).map(item=>auditSafeSnapshot(item,depth+1));
    if(typeof value!=='object')return value;
    const blocked=/password|passwordHash|token|secret|refresh|authorization|cookie|otp/i;
    const out={};
    for(const [key,item] of Object.entries(value)){
      if(blocked.test(key))continue;
      out[key]=auditSafeSnapshot(item,depth+1);
    }
    return out;
  }

  async function auditAdmin(req,action,entityType,entityId,before=null,after=null){
    try{
      await db().collection('audit_logs').insertOne({
        actorType:'ADMIN',actorId:objectIdOrNull(req.adminAccess?.user?.id),
        actorName:req.adminAccess?.user?.fullName||null,actorPhone:req.adminAccess?.user?.phone||null,actorEmail:req.adminAccess?.user?.email||null,
        actorRoleCodes:Array.isArray(req.adminAccess?.roleCodes)?req.adminAccess.roleCodes:[],
        action,entityType,entityId:objectIdOrNull(entityId)||String(entityId||''),
        before:auditSafeSnapshot(before),after:auditSafeSnapshot(after),
        ip:String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'').split(',')[0].trim()||null,
        userAgent:String(req.headers['user-agent']||'').slice(0,500)||null,createdAt:new Date()
      });
    }catch(_){/* audit must not break the requested operation */}
  }

  router.get('/api/admin-access/me',requireAdminAccess(),async(req,res)=>res.json(req.adminAccess));

  // Read-only audit history for internal admin accounts.
  router.get('/api/admin-audit',requireAdminAccess('audit.view'),async(req,res)=>{
    try{
      const limit=Math.min(500,Math.max(1,Number(req.query.limit||250)));
      const filter={actorType:'ADMIN'};
      const action=String(req.query.action||'').trim();
      const actorId=objectIdOrNull(req.query.actorId);
      const from=String(req.query.from||'').trim();
      const to=String(req.query.to||'').trim();
      if(action)filter.action=action;
      if(actorId)filter.actorId=actorId;
      if(from||to){
        filter.createdAt={};
        if(from){const d=new Date(`${from}T00:00:00`);if(!Number.isNaN(d.getTime()))filter.createdAt.$gte=d}
        if(to){const d=new Date(`${to}T23:59:59.999`);if(!Number.isNaN(d.getTime()))filter.createdAt.$lte=d}
        if(!Object.keys(filter.createdAt).length)delete filter.createdAt;
      }

      let logs=await db().collection('audit_logs').find(filter).sort({createdAt:-1}).limit(limit).toArray();
      const actorIds=[...new Set(logs.map(x=>x.actorId).filter(Boolean).map(String))].map(objectIdOrNull).filter(Boolean);
      const actors=actorIds.length?await db().collection('users').find({_id:{$in:actorIds},roles:'ADMIN'}).project({fullName:1,phone:1,email:1,status:1}).toArray():[];
      const actorMap=new Map(actors.map(a=>[String(a._id),a]));
      const q=String(req.query.q||'').trim().toLowerCase();
      const rows=logs.map(log=>{
        const actor=actorMap.get(String(log.actorId||''));
        return {
          ...serializeDoc(log),
          actor:actor?{id:String(actor._id),fullName:actor.fullName||log.actorName||'Quản trị viên',phone:actor.phone||log.actorPhone||null,email:actor.email||log.actorEmail||null,status:actor.status||'ACTIVE'}:{id:log.actorId?String(log.actorId):null,fullName:log.actorName||'Tài khoản cũ/không xác định',phone:log.actorPhone||null,email:log.actorEmail||null,status:null}
        };
      }).filter(row=>{
        if(!q)return true;
        const text=[row.action,row.entityType,row.entityId,row.ip,row.actor?.fullName,row.actor?.phone,row.actor?.email,JSON.stringify(row.before||{}),JSON.stringify(row.after||{})].join(' ').toLowerCase();
        return text.includes(q);
      });
      const actorList=await db().collection('users').find({roles:'ADMIN'}).project({fullName:1,phone:1,email:1,status:1}).sort({fullName:1}).toArray();
      res.json({logs:rows,actors:actorList.map(a=>({id:String(a._id),fullName:a.fullName||'Quản trị viên',phone:a.phone||null,email:a.email||null,status:a.status||'ACTIVE'}))});
    }catch(error){res.status(500).json({message:error.message})}
  });

  // ============================================================
  // CURRENT ADMIN PROFILE
  // Self-service profile editing. Roles/status remain admin-managed.
  // Password change always verifies the current password first.
  // ============================================================
  router.get('/api/admin-profile',requireAdminAccess(),async(req,res)=>{
    try{
      const id=objectIdOrNull(req.adminAccess?.user?.id);
      if(!id)return res.status(401).json({message:'Không xác định được tài khoản đang đăng nhập.'});
      const user=await db().collection('users').findOne({_id:id,roles:'ADMIN'});
      if(!user)return res.status(404).json({message:'Không tìm thấy tài khoản quản trị.'});
      res.json({user:publicInternalAdmin(user)});
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.patch('/api/admin-profile',requireAdminAccess(),async(req,res)=>{
    try{
      const id=objectIdOrNull(req.adminAccess?.user?.id);
      if(!id)return res.status(401).json({message:'Không xác định được tài khoản đang đăng nhập.'});
      const users=db().collection('users');
      const existing=await users.findOne({_id:id,roles:'ADMIN'});
      if(!existing)return res.status(404).json({message:'Không tìm thấy tài khoản quản trị.'});

      const fullName=String(req.body?.fullName||'').trim();
      const phone=String(req.body?.phone||'').trim();
      const email=String(req.body?.email||'').trim().toLowerCase();
      if(!fullName||!phone||!email)return res.status(400).json({message:'Vui lòng nhập đầy đủ họ tên, số điện thoại và email.'});

      const duplicate=await users.findOne({_id:{$ne:id},$or:[{phone},{email}]});
      if(duplicate)return res.status(409).json({message:'Số điện thoại hoặc email đã được sử dụng bởi tài khoản khác.'});

      const now=new Date();
      const result=await users.findOneAndUpdate(
        {_id:id,roles:'ADMIN'},
        {$set:{fullName,phone,email,updatedAt:now}},
        {returnDocument:'after'}
      );
      adminTokenCache.clear();
      await auditAdmin(req,'ADMIN_PROFILE_UPDATE','ADMIN_USER',id,publicInternalAdmin(existing),publicInternalAdmin(result));
      res.json({success:true,user:publicInternalAdmin(result)});
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.post('/api/admin-profile/password',requireAdminAccess(),async(req,res)=>{
    try{
      const id=objectIdOrNull(req.adminAccess?.user?.id);
      if(!id)return res.status(401).json({message:'Không xác định được tài khoản đang đăng nhập.'});
      const currentPassword=String(req.body?.currentPassword||'');
      const newPassword=String(req.body?.newPassword||'');
      if(!currentPassword)return res.status(400).json({message:'Vui lòng nhập mật khẩu hiện tại.'});
      if(newPassword.length<8)return res.status(400).json({message:'Mật khẩu mới phải có ít nhất 8 ký tự.'});
      if(currentPassword===newPassword)return res.status(400).json({message:'Mật khẩu mới phải khác mật khẩu hiện tại.'});

      const users=db().collection('users');
      const existing=await users.findOne({_id:id,roles:'ADMIN'});
      if(!existing||!existing.passwordHash)return res.status(404).json({message:'Tài khoản chưa có mật khẩu hợp lệ.'});

      const passwordOk=await bcrypt.compare(currentPassword,existing.passwordHash);
      if(!passwordOk)return res.status(401).json({message:'Mật khẩu hiện tại không đúng.'});

      const passwordHash=await bcrypt.hash(newPassword,12);
      const now=new Date();
      await users.updateOne({_id:id,roles:'ADMIN'},{$set:{passwordHash,mustChangePassword:false,failedLoginCount:0,updatedAt:now}});
      adminTokenCache.clear();
      await db().collection('auth_sessions').updateMany(
        {userId:id,revokedAt:{$exists:false}},
        {$set:{revokedAt:now,revokeReason:'SELF_PASSWORD_CHANGE',updatedAt:now}}
      ).catch(()=>{});
      await auditAdmin(req,'ADMIN_SELF_PASSWORD_CHANGE','ADMIN_USER',id,null,{passwordChangedAt:now});
      res.json({success:true});
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.get('/api/admin-management/bootstrap',requireAnyAdminAccess(['admins.view','admins.manage','roles.manage']),async(req,res)=>{
    try{
      const [accounts,roles]=await Promise.all([
        req.adminAccess.permissions.includes('admins.view')?db().collection('users').find({roles:'ADMIN'}).sort({createdAt:1,_id:1}).toArray():[],
        db().collection('admin_roles').find({}).sort({code:1}).toArray()
      ]);
      res.json({accounts:accounts.map(publicInternalAdmin),roles:roles.map(r=>({...r,_id:String(r._id)})),permissions:ADMIN_ALL_PERMISSIONS});
    }catch(error){res.status(500).json({message:error.message})}
  });

  router.post('/api/admin-management/accounts',requireAdminAccess('admins.manage'),async(req,res)=>{
    try{
      const fullName=String(req.body?.fullName||'').trim(),phone=String(req.body?.phone||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
      if(!fullName||!phone||!email)return res.status(400).json({message:'Vui lòng nhập họ tên, số điện thoại và email.'});
      if(password.length<8)return res.status(400).json({message:'Mật khẩu phải có ít nhất 8 ký tự.'});
      const roleCodes=await validRoleCodes(req.body?.roleCodes);
      const status=String(req.body?.status||'ACTIVE').toUpperCase()==='BLOCKED'?'BLOCKED':'ACTIVE';
      const users=db().collection('users');
      const duplicate=await users.findOne({$or:[{phone},{email}]});
      if(duplicate)return res.status(409).json({message:'Số điện thoại hoặc email đã được sử dụng bởi tài khoản khác.'});
      const now=new Date(),passwordHash=await bcrypt.hash(password,12);
      const doc={fullName,phone,email,passwordHash,roles:['ADMIN'],adminRoleCodes:roleCodes,roleCodes,status,mustChangePassword:false,failedLoginCount:0,lastLoginAt:null,createdAt:now,updatedAt:now};
      const result=await users.insertOne(doc);const created={...doc,_id:result.insertedId};
      await auditAdmin(req,'ADMIN_ACCOUNT_CREATE','ADMIN_USER',result.insertedId,null,publicInternalAdmin(created));
      res.status(201).json(publicInternalAdmin(created));
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.patch('/api/admin-management/accounts/:id',requireAdminAccess('admins.manage'),async(req,res)=>{
    try{
      const id=objectIdOrNull(req.params.id);if(!id)return res.status(400).json({message:'ID tài khoản không hợp lệ.'});
      const users=db().collection('users'),existing=await users.findOne({_id:id,roles:'ADMIN'});if(!existing)return res.status(404).json({message:'Không tìm thấy tài khoản ADMIN.'});
      const update={updatedAt:new Date()};
      if('fullName'in req.body){const v=String(req.body.fullName||'').trim();if(!v)return res.status(400).json({message:'Họ tên không được để trống.'});update.fullName=v}
      if('phone'in req.body){const v=String(req.body.phone||'').trim();if(!v)return res.status(400).json({message:'Số điện thoại không được để trống.'});if(await users.findOne({_id:{$ne:id},phone:v}))return res.status(409).json({message:'Số điện thoại đã được sử dụng.'});update.phone=v}
      if('email'in req.body){const v=String(req.body.email||'').trim().toLowerCase();if(!v)return res.status(400).json({message:'Email không được để trống.'});if(await users.findOne({_id:{$ne:id},email:v}))return res.status(409).json({message:'Email đã được sử dụng.'});update.email=v}
      if('roleCodes'in req.body){const codes=await validRoleCodes(req.body.roleCodes);if(String(req.adminAccess.user.id)===String(id)&&!codes.includes('SUPER_ADMIN')&&adminRoleCodesOf(existing).includes('SUPER_ADMIN'))return res.status(409).json({message:'Bạn không thể tự gỡ quyền SUPER_ADMIN của chính mình.'});update.adminRoleCodes=codes;update.roleCodes=codes}
      if('status'in req.body){const v=String(req.body.status||'').toUpperCase()==='BLOCKED'?'BLOCKED':'ACTIVE';if(String(req.adminAccess.user.id)===String(id)&&v!=='ACTIVE')return res.status(409).json({message:'Bạn không thể tự khóa tài khoản đang đăng nhập.'});update.status=v}
      const result=await users.findOneAndUpdate({_id:id,roles:'ADMIN'},{$set:update},{returnDocument:'after'});adminTokenCache.clear();
      await auditAdmin(req,'ADMIN_ACCOUNT_UPDATE','ADMIN_USER',id,publicInternalAdmin(existing),publicInternalAdmin(result));
      res.json(publicInternalAdmin(result));
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.post('/api/admin-management/accounts/:id/reset-password',requireAdminAccess('admins.manage'),async(req,res)=>{
    try{
      const id=objectIdOrNull(req.params.id);if(!id)return res.status(400).json({message:'ID tài khoản không hợp lệ.'});const password=String(req.body?.password||'');if(password.length<8)return res.status(400).json({message:'Mật khẩu phải có ít nhất 8 ký tự.'});
      const passwordHash=await bcrypt.hash(password,12),now=new Date();const result=await db().collection('users').updateOne({_id:id,roles:'ADMIN'},{$set:{passwordHash,mustChangePassword:false,failedLoginCount:0,updatedAt:now}});if(!result.matchedCount)return res.status(404).json({message:'Không tìm thấy tài khoản ADMIN.'});
      if(db().collection('auth_sessions'))await db().collection('auth_sessions').updateMany({userId:id,revokedAt:{$exists:false}},{$set:{revokedAt:now,revokeReason:'ADMIN_PASSWORD_RESET',updatedAt:now}}).catch(()=>{});
      adminTokenCache.clear();await auditAdmin(req,'ADMIN_PASSWORD_RESET','ADMIN_USER',id,null,{passwordResetAt:now});res.json({success:true});
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.delete('/api/admin-management/accounts/:id',requireAdminAccess('admins.manage'),async(req,res)=>{
    try{
      const id=objectIdOrNull(req.params.id);if(!id)return res.status(400).json({message:'ID tài khoản không hợp lệ.'});if(String(req.adminAccess.user.id)===String(id))return res.status(409).json({message:'Bạn không thể xóa tài khoản đang đăng nhập.'});
      const users=db().collection('users'),existing=await users.findOne({_id:id,roles:'ADMIN'});if(!existing)return res.status(404).json({message:'Không tìm thấy tài khoản ADMIN.'});
      if(adminRoleCodesOf(existing).includes('SUPER_ADMIN')){const admins=await users.find({roles:'ADMIN',status:'ACTIVE'}).toArray();const superCount=admins.filter(a=>adminRoleCodesOf(a).includes('SUPER_ADMIN')).length;if(superCount<=1)return res.status(409).json({message:'Không thể xóa SUPER_ADMIN cuối cùng của hệ thống.'})}
      await users.deleteOne({_id:id,roles:'ADMIN'});await db().collection('auth_sessions').updateMany({userId:id,revokedAt:{$exists:false}},{$set:{revokedAt:new Date(),revokeReason:'ADMIN_ACCOUNT_DELETED',updatedAt:new Date()}}).catch(()=>{});adminTokenCache.clear();
      await auditAdmin(req,'ADMIN_ACCOUNT_DELETE','ADMIN_USER',id,publicInternalAdmin(existing),null);res.json({success:true});
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.post('/api/admin-management/roles',requireAdminAccess('roles.manage'),async(req,res)=>{
    try{
      const code=String(req.body?.code||'').trim().toUpperCase().replace(/[^A-Z0-9_]/g,'_'),name=String(req.body?.name||'').trim();if(!code||!name)return res.status(400).json({message:'Thiếu mã hoặc tên vai trò.'});if(code==='SUPER_ADMIN')return res.status(409).json({message:'SUPER_ADMIN là vai trò hệ thống.'});
      const permissions=[...new Set((Array.isArray(req.body?.permissions)?req.body.permissions:[]).filter(p=>ADMIN_ALL_PERMISSIONS.includes(p)))],status=String(req.body?.status||'ACTIVE').toUpperCase()==='INACTIVE'?'INACTIVE':'ACTIVE';
      const col=db().collection('admin_roles');if(await col.findOne({code}))return res.status(409).json({message:'Mã vai trò đã tồn tại.'});const now=new Date(),doc={code,name,permissions,status,createdAt:now,updatedAt:now};const result=await col.insertOne(doc);adminTokenCache.clear();await auditAdmin(req,'ADMIN_ROLE_CREATE','ADMIN_ROLE',result.insertedId,null,doc);res.status(201).json({...doc,_id:String(result.insertedId)});
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.patch('/api/admin-management/roles/:id',requireAdminAccess('roles.manage'),async(req,res)=>{
    try{
      const id=objectIdOrNull(req.params.id);if(!id)return res.status(400).json({message:'ID vai trò không hợp lệ.'});const col=db().collection('admin_roles'),existing=await col.findOne({_id:id});if(!existing)return res.status(404).json({message:'Không tìm thấy vai trò.'});
      const update={updatedAt:new Date()};if('name'in req.body){const name=String(req.body.name||'').trim();if(!name)return res.status(400).json({message:'Tên vai trò không được để trống.'});update.name=name}
      if(existing.code==='SUPER_ADMIN'){update.status='ACTIVE';update.permissions=[...ADMIN_ALL_PERMISSIONS]}
      else{if('status'in req.body)update.status=String(req.body.status||'').toUpperCase()==='INACTIVE'?'INACTIVE':'ACTIVE';if('permissions'in req.body)update.permissions=[...new Set((Array.isArray(req.body.permissions)?req.body.permissions:[]).filter(p=>ADMIN_ALL_PERMISSIONS.includes(p)))]}
      const result=await col.findOneAndUpdate({_id:id},{$set:update},{returnDocument:'after'});adminTokenCache.clear();await auditAdmin(req,'ADMIN_ROLE_UPDATE','ADMIN_ROLE',id,existing,result);res.json({...result,_id:String(result._id)});
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.delete('/api/admin-management/roles/:id',requireAdminAccess('roles.manage'),async(req,res)=>{
    try{
      const id=objectIdOrNull(req.params.id);if(!id)return res.status(400).json({message:'ID vai trò không hợp lệ.'});const col=db().collection('admin_roles'),role=await col.findOne({_id:id});if(!role)return res.status(404).json({message:'Không tìm thấy vai trò.'});if(role.code==='SUPER_ADMIN')return res.status(409).json({message:'Không thể xóa vai trò SUPER_ADMIN.'});
      const assigned=await db().collection('users').countDocuments({roles:'ADMIN',$or:[{adminRoleCodes:role.code},{roleCodes:role.code}]});if(assigned)return res.status(409).json({message:`Vai trò đang được gán cho ${assigned} tài khoản. Hãy đổi vai trò tài khoản trước khi xóa.`});
      await col.deleteOne({_id:id});adminTokenCache.clear();await auditAdmin(req,'ADMIN_ROLE_DELETE','ADMIN_ROLE',id,role,null);res.json({success:true});
    }catch(error){res.status(400).json({message:error.message})}
  });

  router.get('/api/health', async (_req, res) => {
    try {
      await db().command({ ping: 1 });
      const counts = {};
      for (const key of allowedArrayKeys) counts[key] = await db().collection(collectionMap[key]).countDocuments();
      res.json({ success: true, service: 'TH79_IMOVE_CORE_ADMIN', version: APP_VERSION, mergedIntoCore: true, backendUrl: CORE_BACKEND_URL, database: DB_NAME, state: 'CONNECTED', counts });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get('/api/bootstrap', requireAdminAccess(), async (_req, res) => {
    try {
      const [customers, drivers, trips, payments, revenue, settings] = await Promise.all([
        getArrayData('customers'),
        getArrayData('drivers'),
        getArrayData('trips'),
        getArrayData('payments'),
        getArrayData('revenue'),
        getSettings()
      ]);
      res.json({ customers, drivers, trips, payments, revenue, settings });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.get('/api/data/settings', requireAdminAccess('settings.view'), async (_req, res) => {
    try { res.json(await getSettings()); }
    catch (error) { res.status(500).json({ message: error.message }); }
  });

  router.put('/api/data/settings', requireAdminAccess('settings.manage'), async (req, res) => {
    try {
      const before=await getSettings();
      const after=await saveSettings(req.body || {});
      await auditAdmin(req,'SETTINGS_UPDATE','SETTINGS','th79_imove_admin',before,after);
      res.json(after);
    }
    catch (error) { res.status(500).json({ message: error.message }); }
  });

  router.get('/api/data/:key', requireAdminAccess(), async (req, res) => {
    try {
      const { key } = req.params;
      if (!allowedArrayKeys.has(key)) return res.status(404).json({ message: 'Collection không được hỗ trợ' });
      res.json(await getArrayData(key));
    } catch (error) { res.status(500).json({ message: error.message }); }
  });

  router.put('/api/data/:key', requireAdminAccess(), async (req, res) => {
    try {
      const { key } = req.params;
      if (!allowedArrayKeys.has(key)) return res.status(404).json({ message: 'Collection không được hỗ trợ' });
      const beforeCount=await db().collection(collectionMap[key]).countDocuments();
      const result=await syncArrayData(key, req.body);
      await auditAdmin(req,'ADMIN_DATA_SYNC','ADMIN_DATA',key,{collection:key,count:beforeCount},{collection:key,count:Array.isArray(result)?result.length:0});
      res.json(result);
    } catch (error) { res.status(500).json({ message: error.message }); }
  });



  // ============================================================
  // USERS / CUSTOMERS
  // Admin customer page reads users and only mutates CUSTOMER accounts.
  // ============================================================
  const USER_STATUSES = new Set(['ACTIVE','INACTIVE','BLOCKED','DELETED']);
  router.patch('/api/users/:id', requireAdminAccess('users.update'), async (req, res) => {
    try {
      if (!ObjectId.isValid(String(req.params.id))) return res.status(400).json({ message: 'ID người dùng MongoDB không hợp lệ' });
      const id = new ObjectId(String(req.params.id));
      const existing = await db().collection('users').findOne({ _id: id, roles: 'CUSTOMER' });
      if (!existing) return res.status(404).json({ message: 'Không tìm thấy tài khoản CUSTOMER' });
      const update = { updatedAt: new Date() };
      if ('fullName' in req.body) {
        const fullName = String(req.body.fullName || '').trim();
        if (!fullName) return res.status(400).json({ message: 'Họ và tên không được để trống' });
        update.fullName = fullName;
      }
      if ('phone' in req.body) {
        const phone = String(req.body.phone || '').trim();
        if (!phone) return res.status(400).json({ message: 'Số điện thoại không được để trống' });
        const duplicate = await db().collection('users').findOne({ phone, _id: { $ne: id } });
        if (duplicate) return res.status(409).json({ message: 'Số điện thoại đã được sử dụng' });
        update.phone = phone;
      }
      if ('email' in req.body) update.email = req.body.email == null || String(req.body.email).trim() === '' ? null : String(req.body.email).trim();
      if ('status' in req.body) {
        const status = String(req.body.status || '').trim().toUpperCase();
        if (!USER_STATUSES.has(status)) return res.status(400).json({ message: 'Trạng thái người dùng không hợp lệ' });
        update.status = status;
      }
      const result = await db().collection('users').findOneAndUpdate({ _id: id, roles: 'CUSTOMER' }, { $set: update }, { returnDocument: 'after' });
      await auditAdmin(req,'CUSTOMER_UPDATE','CUSTOMER',id,serializeDoc(existing),serializeDoc(result));
      res.json(serializeDoc(result));
    } catch (error) { res.status(500).json({ message: error.message }); }
  });

  router.delete('/api/users/:id', requireAdminAccess('users.block'), async (req, res) => {
    try {
      if (!ObjectId.isValid(String(req.params.id))) return res.status(400).json({ message: 'ID người dùng MongoDB không hợp lệ' });
      const id = new ObjectId(String(req.params.id));
      const existing = await db().collection('users').findOne({ _id: id, roles: 'CUSTOMER' });
      if (!existing) return res.status(404).json({ message: 'Không tìm thấy tài khoản CUSTOMER' });
      const bookingCount = await db().collection(collectionMap.trips).countDocuments({ customerId: id });
      if (bookingCount > 0) return res.status(409).json({ message: `Khách hàng đã có ${bookingCount} chuyến xe. Hãy khóa tài khoản thay vì xóa để giữ lịch sử.` });
      const result = await db().collection('users').deleteOne({ _id: id, roles: 'CUSTOMER' });
      if (!result.deletedCount) return res.status(404).json({ message: 'Không tìm thấy tài khoản CUSTOMER' });
      await auditAdmin(req,'CUSTOMER_DELETE','CUSTOMER',id,serializeDoc(existing),null);
      res.json({ success: true });
    } catch (error) { res.status(500).json({ message: error.message }); }
  });

  // ============================================================
  // BOOKINGS / TRIPS
  // MongoDB schema uses bookings with uppercase workflow statuses.
  // This endpoint updates only the booking status and avoids syncing
  // UI-shaped trip rows back over the booking document.
  // ============================================================
  const BOOKING_STATUSES = new Set([
    'DRAFT','SEARCHING','DRIVER_ASSIGNED','DRIVER_ARRIVING','DRIVER_ARRIVED',
    'IN_PROGRESS','COMPLETED','CANCELLED','CANCELLED_BY_USER',
    'CANCELLED_BY_DRIVER','EXPIRED'
  ]);

  router.patch('/api/bookings/:id/status', requireAdminAccess('bookings.adjust'), async (req, res) => {
    try {
      const status = String(req.body?.status || '').trim().toUpperCase();
      if (!BOOKING_STATUSES.has(status)) return res.status(400).json({ message: 'Trạng thái chuyến không hợp lệ' });
      if (!ObjectId.isValid(String(req.params.id))) return res.status(400).json({ message: 'ID booking MongoDB không hợp lệ' });
      const id = new ObjectId(String(req.params.id));
      const existing = await db().collection(collectionMap.trips).findOne({ _id: id });
      if (!existing) return res.status(404).json({ message: 'Không tìm thấy chuyến xe' });
      const result = await db().collection(collectionMap.trips).findOneAndUpdate(
        { _id: id },
        { $set: { status, updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      if (!result) return res.status(404).json({ message: 'Không tìm thấy chuyến xe' });
      await auditAdmin(req,'BOOKING_STATUS_UPDATE','BOOKING',id,{id:String(existing._id),bookingCode:existing.bookingCode||existing.code||null,status:existing.status},{id:String(result._id),bookingCode:result.bookingCode||result.code||null,status:result.status});
      res.json(serializeDoc(result));
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================
  // PRICING / FARE ENGINE
  // SOURCE OF TRUTH: MongoDB only. No hard-coded fare values.
  // ============================================================
  function asNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(typeof value === 'object' && value?.toString ? value.toString() : value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function nullableNumber(value) { return value === null || value === undefined || value === '' ? null : asNumber(value); }
  function asInt(value) { return new Int32(Math.trunc(asNumber(value))); }
  function normalizeCode(value) { return String(value || '').trim().toUpperCase(); }
  function requireField(body, key, label = key) {
    if (body?.[key] === undefined || body?.[key] === null || String(body[key]).trim() === '') throw new Error(`Thiếu ${label}`);
  }
  function pricingDoc(doc) {
    if (!doc) return null;
    const out = serializeDoc(doc);
    for (const key of ['version','baseFare','baseDistanceKm','minimumFare','pricePerMinute','roundingUnit','bookingFee','customerServiceFee','driverFixedFee','paymentFeePercent']) {
      if (key in out && out[key] !== null) out[key] = asNumber(out[key]);
    }
    if (Array.isArray(out.distanceTiers)) out.distanceTiers = out.distanceTiers.map(t => ({ ...t, fromKm: asNumber(t.fromKm), toKm: t.toKm == null ? null : asNumber(t.toKm), pricePerKm: asNumber(t.pricePerKm) }));
    if (out.driverCommission) out.driverCommission = { ...out.driverCommission, value: asNumber(out.driverCommission.value) };
    if ('value' in out) out.value = asNumber(out.value);
    return out;
  }
  function objectIdFilter(id) {
    if (!ObjectId.isValid(String(id))) throw new Error('ID MongoDB không hợp lệ');
    return { _id: new ObjectId(String(id)) };
  }
  async function nextVersion(collectionName, serviceCode, areaCode) {
    const last = await db().collection(collectionName).find({ serviceCode, areaCode }).sort({ version: -1 }).limit(1).toArray();
    return last.length ? asNumber(last[0].version) + 1 : 1;
  }
  async function archiveOtherActive(collectionName, serviceCode, areaCode, exceptId = null) {
    const filter = { serviceCode, areaCode, status: 'ACTIVE' };
    if (exceptId) filter._id = { $ne: exceptId };
    await db().collection(collectionName).updateMany(filter, { $set: { status: 'ARCHIVED', updatedAt: new Date() } });
  }
  async function ensurePricingScope({ serviceCode, serviceName, areaCode, areaName }) {
    const service = normalizeCode(serviceCode), area = normalizeCode(areaCode), now = new Date();
    if (!service) throw new Error('Thiếu serviceCode');
    if (!area) throw new Error('Thiếu areaCode');
    const services = db().collection('services'), areas = db().collection('service_areas');
    if (!(await services.findOne({ code: service }))) {
      await services.insertOne({ code: service, name: String(serviceName || service).trim() || service, description: null, iconKey: null, status: 'ACTIVE', createdAt: now, updatedAt: now });
    }
    const existingArea = await areas.findOne({ code: area });
    if (!existingArea) {
      await areas.insertOne({ code: area, name: String(areaName || area).trim() || area, provinceCode: null, center: null, boundary: null, enabledServices: [service], status: 'ACTIVE', createdAt: now, updatedAt: now });
    } else {
      await areas.updateOne({ _id: existingArea._id }, { $addToSet: { enabledServices: service }, $set: { updatedAt: now } });
    }
  }
  async function findActiveConfig(collectionName, serviceCode, areaCode) {
    const now = new Date();
    const base = { serviceCode, status: 'ACTIVE', $and: [
      { $or: [{ effectiveFrom: null }, { effectiveFrom: { $exists: false } }, { effectiveFrom: { $lte: now } }] },
      { $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: now } }] }
    ]};
    let doc = await db().collection(collectionName).findOne({ ...base, areaCode }, { sort: { version: -1, effectiveFrom: -1 } });
    if (!doc && areaCode !== 'GLOBAL') doc = await db().collection(collectionName).findOne({ ...base, areaCode: 'GLOBAL' }, { sort: { version: -1, effectiveFrom: -1 } });
    return doc;
  }

  router.get('/api/pricing/bootstrap', requireAdminAccess('pricing.view'), async (_req, res) => {
    try {
      const [services, areas, fares, fees, surcharges] = await Promise.all([
        db().collection('services').find({}).sort({ sortOrder: 1, code: 1 }).toArray(),
        db().collection('service_areas').find({}).sort({ code: 1 }).toArray(),
        db().collection('fare_configs').find({}).sort({ serviceCode: 1, areaCode: 1, version: -1 }).toArray(),
        db().collection('platform_fees').find({}).sort({ serviceCode: 1, areaCode: 1, version: -1 }).toArray(),
        db().collection('surcharges').find({}).sort({ serviceCode: 1, code: 1 }).toArray()
      ]);
      res.json({ services: services.map(serializeDoc), areas: areas.map(serializeDoc), fares: fares.map(pricingDoc), fees: fees.map(pricingDoc), surcharges: surcharges.map(pricingDoc) });
    } catch (error) { res.status(500).json({ message: error.message }); }
  });

  router.post('/api/pricing/fare', requireAdminAccess('pricing.create'), async (req, res) => {
    try {
      for (const [k,l] of [['serviceCode','mã dịch vụ'],['areaCode','mã khu vực'],['baseFare','giá mở cửa'],['baseDistanceKm','km cơ bản'],['minimumFare','giá tối thiểu'],['pricePerMinute','giá/phút'],['roundingUnit','đơn vị làm tròn']]) requireField(req.body,k,l);
      const serviceCode = normalizeCode(req.body.serviceCode), areaCode = normalizeCode(req.body.areaCode);
      const status = ['DRAFT','ACTIVE'].includes(req.body.status) ? req.body.status : 'DRAFT';
      const roundingUnit = asNumber(req.body.roundingUnit); if (roundingUnit <= 0) return res.status(400).json({ message: 'Đơn vị làm tròn phải lớn hơn 0' });
      await ensurePricingScope({ serviceCode, serviceName: req.body.serviceName, areaCode, areaName: req.body.areaName });
      const version = await nextVersion('fare_configs', serviceCode, areaCode); if (status === 'ACTIVE') await archiveOtherActive('fare_configs', serviceCode, areaCode);
      const now = new Date();
      const doc = { serviceCode, areaCode, version: asInt(version), status, currency: 'VND', baseFare: asNumber(req.body.baseFare), baseDistanceKm: asNumber(req.body.baseDistanceKm), minimumFare: asNumber(req.body.minimumFare), pricePerMinute: asNumber(req.body.pricePerMinute), roundingUnit: asInt(roundingUnit),
        distanceTiers: Array.isArray(req.body.distanceTiers) ? req.body.distanceTiers.map(t => ({ fromKm: asNumber(t.fromKm), toKm: t.toKm == null || t.toKm === '' ? null : asNumber(t.toKm), pricePerKm: asNumber(t.pricePerKm) })) : [],
        effectiveFrom: status === 'ACTIVE' ? now : null, effectiveTo: null, note: req.body.note || null, createdBy: null, approvedBy: null, createdAt: now, updatedAt: now };
      const result = await db().collection('fare_configs').insertOne(doc);
      const created=pricingDoc({ ...doc, _id: result.insertedId });
      await auditAdmin(req,'FARE_CREATE','FARE_CONFIG',result.insertedId,null,created);
      res.status(201).json(created);
    } catch (error) { res.status(400).json({ message: error.message }); }
  });
  router.put('/api/pricing/fare/:id', requireAdminAccess('pricing.create'), async (req, res) => {
    try {
      const id = new ObjectId(req.params.id), col = db().collection('fare_configs'), existing = await col.findOne({ _id: id });
      if (!existing) return res.status(404).json({ message: 'Không tìm thấy bảng giá' });
      for (const [k,l] of [['baseFare','giá mở cửa'],['baseDistanceKm','km cơ bản'],['minimumFare','giá tối thiểu'],['pricePerMinute','giá/phút'],['roundingUnit','đơn vị làm tròn']]) requireField(req.body,k,l);
      const status = ['DRAFT','ACTIVE','ARCHIVED'].includes(req.body.status) ? req.body.status : existing.status;
      const roundingUnit = asNumber(req.body.roundingUnit); if (roundingUnit <= 0) return res.status(400).json({ message: 'Đơn vị làm tròn phải lớn hơn 0' });
      if (status === 'ACTIVE') await archiveOtherActive('fare_configs', existing.serviceCode, existing.areaCode, id);
      const clean = { status, baseFare: asNumber(req.body.baseFare), baseDistanceKm: asNumber(req.body.baseDistanceKm), minimumFare: asNumber(req.body.minimumFare), pricePerMinute: asNumber(req.body.pricePerMinute), roundingUnit: asInt(roundingUnit),
        distanceTiers: Array.isArray(req.body.distanceTiers) ? req.body.distanceTiers.map(t => ({ fromKm: asNumber(t.fromKm), toKm: t.toKm == null || t.toKm === '' ? null : asNumber(t.toKm), pricePerKm: asNumber(t.pricePerKm) })) : [], note: req.body.note || null, updatedAt: new Date() };
      if (status === 'ACTIVE' && !existing.effectiveFrom) clean.effectiveFrom = new Date();
      const result = await col.findOneAndUpdate({ _id: id }, { $set: clean }, { returnDocument: 'after' });
      await auditAdmin(req,'FARE_UPDATE','FARE_CONFIG',id,pricingDoc(existing),pricingDoc(result));
      res.json(pricingDoc(result));
    } catch (error) { res.status(400).json({ message: error.message }); }
  });
  router.delete('/api/pricing/fare/:id', requireAdminAccess('pricing.archive'), async (req,res) => {
    try {
      const filter=objectIdFilter(req.params.id),col=db().collection('fare_configs'),existing=await col.findOne(filter);
      if(!existing)return res.status(404).json({message:'Không tìm thấy bảng giá'});
      const r=await col.deleteOne(filter);if(!r.deletedCount)return res.status(404).json({message:'Không tìm thấy bảng giá'});
      await auditAdmin(req,'FARE_DELETE','FARE_CONFIG',existing._id,pricingDoc(existing),null);res.json({success:true});
    } catch(error){res.status(400).json({message:error.message})}
  });

  router.post('/api/pricing/platform-fee', requireAdminAccess('fees.manage'), async (req,res) => {
    try {
      requireField(req.body,'serviceCode'); requireField(req.body,'areaCode');
      if (!req.body.driverCommission || String(req.body.driverCommission.value ?? '').trim() === '') throw new Error('Thiếu hoa hồng tài xế');
      const serviceCode=normalizeCode(req.body.serviceCode), areaCode=normalizeCode(req.body.areaCode), status=['DRAFT','ACTIVE'].includes(req.body.status)?req.body.status:'DRAFT';
      await ensurePricingScope({serviceCode,areaCode}); const version=await nextVersion('platform_fees',serviceCode,areaCode); if(status==='ACTIVE')await archiveOtherActive('platform_fees',serviceCode,areaCode);
      const now=new Date(), doc={serviceCode,areaCode,version:asInt(version),status,driverCommission:{type:req.body.driverCommission.type==='FIXED'?'FIXED':'PERCENT',value:asNumber(req.body.driverCommission.value)},effectiveFrom:status==='ACTIVE'?now:null,effectiveTo:null,createdAt:now,updatedAt:now};
      for (const key of ['bookingFee','customerServiceFee','driverFixedFee','paymentFeePercent']) { const v=nullableNumber(req.body[key]); if(v!==null) doc[key]=v; }
      const r=await db().collection('platform_fees').insertOne(doc);const created=pricingDoc({...doc,_id:r.insertedId});
      await auditAdmin(req,'PLATFORM_FEE_CREATE','PLATFORM_FEE',r.insertedId,null,created);res.status(201).json(created);
    } catch(error){res.status(400).json({message:error.message})}
  });
  router.put('/api/pricing/platform-fee/:id', requireAdminAccess('fees.manage'), async (req,res) => {
    try {
      const id=new ObjectId(req.params.id), col=db().collection('platform_fees'), existing=await col.findOne({_id:id}); if(!existing)return res.status(404).json({message:'Không tìm thấy cấu hình phí nền tảng'});
      if(!req.body.driverCommission || String(req.body.driverCommission.value ?? '').trim()==='')throw new Error('Thiếu hoa hồng tài xế');
      const status=['DRAFT','ACTIVE','ARCHIVED'].includes(req.body.status)?req.body.status:existing.status; if(status==='ACTIVE')await archiveOtherActive('platform_fees',existing.serviceCode,existing.areaCode,id);
      const clean={status,driverCommission:{type:req.body.driverCommission.type==='FIXED'?'FIXED':'PERCENT',value:asNumber(req.body.driverCommission.value)},updatedAt:new Date()}, unset={};
      for (const key of ['bookingFee','customerServiceFee','driverFixedFee','paymentFeePercent']) { const v=nullableNumber(req.body[key]); if(v===null) unset[key]=''; else clean[key]=v; }
      if(status==='ACTIVE'&&!existing.effectiveFrom)clean.effectiveFrom=new Date();
      const update={$set:clean}; if(Object.keys(unset).length)update.$unset=unset;
      const r=await col.findOneAndUpdate({_id:id},update,{returnDocument:'after'});
      await auditAdmin(req,'PLATFORM_FEE_UPDATE','PLATFORM_FEE',id,pricingDoc(existing),pricingDoc(r));res.json(pricingDoc(r));
    } catch(error){res.status(400).json({message:error.message})}
  });
  router.delete('/api/pricing/platform-fee/:id', requireAdminAccess('fees.manage'), async (req,res) => {
    try {const filter=objectIdFilter(req.params.id),col=db().collection('platform_fees'),existing=await col.findOne(filter);if(!existing)return res.status(404).json({message:'Không tìm thấy cấu hình phí'});const r=await col.deleteOne(filter);if(!r.deletedCount)return res.status(404).json({message:'Không tìm thấy cấu hình phí'});await auditAdmin(req,'PLATFORM_FEE_DELETE','PLATFORM_FEE',existing._id,pricingDoc(existing),null);res.json({success:true});}
    catch(error){res.status(400).json({message:error.message})}
  });

  router.post('/api/pricing/surcharge', requireAdminAccess('fees.manage'), async (req,res) => {
    try {
      for(const key of ['code','name','serviceCode','calculationType','value','status']) requireField(req.body,key);
      const code=normalizeCode(req.body.code), serviceCode=normalizeCode(req.body.serviceCode); if(!['FIXED','PERCENT','MULTIPLIER'].includes(req.body.calculationType))throw new Error('Kiểu phụ phí không hợp lệ'); if(!['ACTIVE','INACTIVE'].includes(req.body.status))throw new Error('Trạng thái phụ phí không hợp lệ');
      const col=db().collection('surcharges'); if(await col.findOne({code}))return res.status(409).json({message:`Mã phụ phí ${code} đã tồn tại`});
      const areas=Array.isArray(req.body.areaCodes)?req.body.areaCodes.map(normalizeCode).filter(Boolean):[]; await ensurePricingScope({serviceCode,areaCode:areas[0]||'GLOBAL'});
      const now=new Date(), doc={code,name:String(req.body.name).trim(),serviceCode,areaCodes:areas,calculationType:req.body.calculationType,value:asNumber(req.body.value),conditions:null,status:req.body.status,createdAt:now,updatedAt:now}; const r=await col.insertOne(doc);const created=pricingDoc({...doc,_id:r.insertedId});await auditAdmin(req,'SURCHARGE_CREATE','SURCHARGE',r.insertedId,null,created);res.status(201).json(created);
    } catch(error){res.status(400).json({message:error.message})}
  });
  router.patch('/api/pricing/surcharge/:id', requireAdminAccess('fees.manage'), async (req,res) => {
    try { const clean={...req.body,updatedAt:new Date()}; delete clean._id; delete clean.id; if('code'in clean)clean.code=normalizeCode(clean.code); if('serviceCode'in clean)clean.serviceCode=normalizeCode(clean.serviceCode); if('areaCodes'in clean)clean.areaCodes=Array.isArray(clean.areaCodes)?clean.areaCodes.map(normalizeCode).filter(Boolean):[]; if('value'in clean)clean.value=asNumber(clean.value); const filter=objectIdFilter(req.params.id),col=db().collection('surcharges'),existing=await col.findOne(filter);if(!existing)return res.status(404).json({message:'Không tìm thấy phụ phí'});const r=await col.findOneAndUpdate(filter,{$set:clean},{returnDocument:'after'}); if(!r)return res.status(404).json({message:'Không tìm thấy phụ phí'});await auditAdmin(req,'SURCHARGE_UPDATE','SURCHARGE',existing._id,pricingDoc(existing),pricingDoc(r)); res.json(pricingDoc(r)); } catch(error){res.status(400).json({message:error.message})}
  });
  router.delete('/api/pricing/surcharge/:id', requireAdminAccess('fees.manage'), async (req,res) => {
    try {const filter=objectIdFilter(req.params.id),col=db().collection('surcharges'),existing=await col.findOne(filter);if(!existing)return res.status(404).json({message:'Không tìm thấy phụ phí'});const r=await col.deleteOne(filter);if(!r.deletedCount)return res.status(404).json({message:'Không tìm thấy phụ phí'});await auditAdmin(req,'SURCHARGE_DELETE','SURCHARGE',existing._id,pricingDoc(existing),null);res.json({success:true});}
    catch(error){res.status(400).json({message:error.message})}
  });

  router.post('/api/fares/estimate', async (req,res) => {
    try {
      const serviceCode=normalizeCode(req.body?.serviceCode), areaCode=normalizeCode(req.body?.areaCode||'GLOBAL'), distanceKm=Math.max(0,asNumber(req.body?.distanceKm)), durationMinutes=Math.max(0,asNumber(req.body?.durationMinutes));
      const selected=Array.isArray(req.body?.surchargeCodes)?req.body.surchargeCodes.map(normalizeCode):[]; if(!serviceCode)return res.status(400).json({message:'Thiếu serviceCode'});
      const fare=await findActiveConfig('fare_configs',serviceCode,areaCode); if(!fare)return res.status(404).json({message:`Không tìm thấy bảng giá ACTIVE cho ${serviceCode}.`}); const fee=await findActiveConfig('platform_fees',serviceCode,areaCode);
      const baseFare=asNumber(fare.baseFare), minimumFare=asNumber(fare.minimumFare), timeFare=durationMinutes*asNumber(fare.pricePerMinute); let distanceFare=0;
      for(const tier of (Array.isArray(fare.distanceTiers)?fare.distanceTiers:[])){const from=Math.max(0,asNumber(tier.fromKm)),to=tier.toKm==null?Infinity:Math.max(from,asNumber(tier.toKm));if(distanceKm>from)distanceFare+=Math.max(0,Math.min(distanceKm,to)-from)*asNumber(tier.pricePerKm)}
      const rideFare=Math.max(minimumFare,baseFare+distanceFare+timeFare); let surcharge=0; const appliedSurcharges=[];
      if(selected.length){const docs=await db().collection('surcharges').find({serviceCode,status:'ACTIVE',code:{$in:selected},$or:[{areaCodes:areaCode},{areaCodes:'GLOBAL'},{areaCodes:{$size:0}},{areaCodes:{$exists:false}}]}).toArray();for(const item of docs){const value=asNumber(item.value);let amount=item.calculationType==='FIXED'?value:item.calculationType==='PERCENT'?rideFare*value/100:item.calculationType==='MULTIPLIER'?rideFare*Math.max(0,value-1):0;surcharge+=amount;appliedSurcharges.push({code:item.code,name:item.name,calculationType:item.calculationType,value,amount:Math.round(amount)})}}
      const bookingFee=asNumber(fee?.bookingFee),customerServiceFee=asNumber(fee?.customerServiceFee),paymentFeePercent=asNumber(fee?.paymentFeePercent),beforePayment=rideFare+surcharge+bookingFee+customerServiceFee,paymentFee=beforePayment*paymentFeePercent/100,rawTotal=beforePayment+paymentFee,roundingUnit=asNumber(fare.roundingUnit); if(roundingUnit<=0)return res.status(500).json({message:'roundingUnit của bảng giá ACTIVE không hợp lệ'}); const total=Math.round(rawTotal/roundingUnit)*roundingUnit;
      res.json({serviceCode,requestedAreaCode:areaCode,appliedAreaCode:fare.areaCode,fallbackToGlobal:fare.areaCode!==areaCode,distanceKm,durationMinutes,currency:fare.currency||'VND',fareConfigVersion:asNumber(fare.version),platformFeeVersion:fee?asNumber(fee.version):null,pricing:{baseFare,distanceFare:Math.round(distanceFare),timeFare:Math.round(timeFare),minimumFare,rideFare:Math.round(rideFare),surcharge:Math.round(surcharge),appliedSurcharges,bookingFee,customerServiceFee,paymentFee:Math.round(paymentFee),subtotal:Math.round(rawTotal),roundingUnit,total}});
    } catch(error){res.status(500).json({message:error.message})}
  });


  // Seed/index RBAC lazily when the Core database is ready.
  router.ensureAdminRbacSeed = ensureAdminRbacSeed;
  return router;
}

module.exports = { createAdminConsoleRouter, ADMIN_ALL_PERMISSIONS };
