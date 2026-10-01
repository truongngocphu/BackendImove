const express=require('express');
const multer=require('multer');
const fs=require('fs');
const path=require('path');
const jwt=require('jsonwebtoken');
const {ObjectId}=require('mongodb');
const {createAdminGuard}=require('./admin_guard');
const {paths:localPaths,randomStoredName,removeFileQuiet}=require('./local_storage_service');

function oid(v){try{return new ObjectId(String(v));}catch(_){return null;}}
function jwtSecret(){const s=String(process.env.JWT_ACCESS_SECRET||'').trim();if(s.length<32)throw new Error('JWT_ACCESS_SECRET chưa an toàn.');return s;}
function createTrustRouter({getDb,getTrust,getProduction,findDriverByPhone}){
  const r=express.Router();
  const incomingDir=path.join(localPaths.faceEvidence,'_incoming');
  fs.mkdirSync(incomingDir,{recursive:true});
  const faceMaxMb=Math.max(1,Math.min(10,Number(process.env.FACE_EVIDENCE_MAX_FILE_MB||5)));
  const upload=multer({
    storage:multer.diskStorage({
      destination:(_req,_file,cb)=>cb(null,incomingDir),
      filename:(_req,file,cb)=>cb(null,randomStoredName(file,'face')),
    }),
    limits:{fileSize:faceMaxMb*1024*1024},
    fileFilter:(_req,file,cb)=>{
      if(/^image\/(jpeg|png|webp)$/i.test(String(file.mimetype||'')))return cb(null,true);
      return cb(new Error('Ảnh khuôn mặt chỉ chấp nhận JPEG/PNG/WEBP.'));
    },
  });
  async function auth(req,res,next){try{const h=String(req.headers.authorization||'');if(!h.startsWith('Bearer '))return res.status(401).json({message:'Thiếu Access Token.'});const p=jwt.verify(h.slice(7),jwtSecret());const id=oid(p.sub||p.userId);const u=await getDb().collection('users').findOne({_id:id});if(!u)return res.status(401).json({message:'Tài khoản không hợp lệ.'});req.user=u;req.role=Array.isArray(u.roles)&&u.roles.includes('DRIVER')?'DRIVER':'CUSTOMER';next();}catch(_){return res.status(401).json({message:'Phiên đăng nhập không hợp lệ.'});}}
  r.use(auth);
  async function appCheck(req,res,next){
    // iMove 1.6.0 runs MongoDB-first. Firebase App Check is not a required
    // dependency. Integrity verification can be enabled later with a provider
    // that is independent from the notification/data layer.
    try {
      const config=getProduction?await getProduction().loadProductionConfig():null;
      const required=config ? Boolean(config?.securityPolicy?.requireIntegrity) : String(process.env.APP_INTEGRITY_REQUIRED||'false').toLowerCase()==='true';
      const provider=String(process.env.APP_INTEGRITY_PROVIDER||'NONE').toUpperCase();
      const token=String(req.headers['x-imove-integrity']||'').trim();
      if(!required || provider==='NONE') {
        req.appIntegrity={verified:false,provider:'NONE'};
        return next();
      }
      if(provider==='HEADER') {
        if(!token) return res.status(401).json({code:'APP_INTEGRITY_REQUIRED',message:'Thiếu iMove integrity token.'});
        req.appIntegrity={verified:true,provider:'HEADER'};
        return next();
      }
      req.appIntegrity={verified:false,provider};
      return next();
    } catch(e) {
      await getTrust().addRiskEvent({subjectId:req.user?._id,subjectType:req.role||'CUSTOMER',type:'APP_INTEGRITY_FAILED',severity:'HIGH',dedupeKey:`APP_INTEGRITY:${req.user?._id}:${Math.floor(Date.now()/60000)}`,evidence:{message:e.message}}).catch(()=>{});
      return res.status(401).json({code:'APP_INTEGRITY_FAILED',message:'Không xác minh được tính toàn vẹn ứng dụng.'});
    }
  }
  r.use(appCheck);
  r.post('/devices/register',async(req,res)=>{try{return res.json(await getTrust().registerDevice({userId:req.user._id,role:req.role,...req.body,integrity:req.appIntegrity?.verified?'VERIFIED':(req.body?.integrity||'UNVERIFIED')}));}catch(e){return res.status(400).json({message:e.message});}});
  r.post('/devices/biometric-verified',async(req,res)=>{try{return res.json(await getTrust().markBiometric({userId:req.user._id,role:req.role,deviceId:req.body?.deviceId}));}catch(e){return res.status(400).json({message:e.message});}});
  r.get('/risk/me',async(req,res)=>res.json(await getTrust().score(req.user._id,req.role)));
  r.get('/driver/trust/me',async(req,res)=>{if(req.role!=='DRIVER')return res.status(403).json({message:'Chỉ dành cho tài xế.'});const found=await findDriverByPhone(req.user.phone);if(!found)return res.status(404).json({message:'Không tìm thấy tài xế.'});return res.json(await getTrust().driverTrustStatus({driver:found.driver,user:req.user}));});
  r.get('/driver/identity/challenge',async(req,res)=>{if(req.role!=='DRIVER')return res.status(403).json({message:'Chỉ dành cho tài xế.'});const found=await findDriverByPhone(req.user.phone);return res.json(await getTrust().createFaceChallenge({userId:req.user._id,driverId:found?.driver?._id,trigger:req.query.trigger||'GO_ONLINE'}));});
  r.post('/driver/identity/face/complete',upload.single('selfie'),async(req,res)=>{
    let tempPath=req.file?.path||null;
    try{
      if(req.role!=='DRIVER')return res.status(403).json({message:'Chỉ dành cho tài xế.'});
      const actions=String(req.body?.actionsCompleted||'').split(',').map(x=>x.trim()).filter(Boolean);
      const imageBuffer=tempPath?await fs.promises.readFile(tempPath):null;
      const value=await getTrust().completeFace({challengeId:req.body?.challengeId,userId:req.user._id,role:'DRIVER',imageBuffer,imageMime:req.file?.mimetype||'image/jpeg',deviceId:req.body?.deviceId,actionsCompleted:actions});
      return res.json(value);
    }catch(e){return res.status(400).json({message:e.message});}
    finally{if(tempPath)await removeFileQuiet(tempPath,localPaths.faceEvidence);}
  });
  r.post('/driver/security-heartbeat',async(req,res)=>{try{if(req.role!=='DRIVER')return res.status(403).json({message:'Chỉ dành cho tài xế.'});const found=await findDriverByPhone(req.user.phone);if(!found)return res.status(404).json({message:'Không tìm thấy tài xế.'});return res.json(await getTrust().analyzeLocation({driverId:found.driver._id,userId:req.user._id,...req.body}));}catch(e){return res.status(400).json({message:e.message});}});
  return r;
}

function createTrustAdminRouter({getDb,getTrust}){
  const r=express.Router();
  // Use the same RBAC guard as every other Admin module. Besides removing
  // duplicated auth logic, this preserves backward compatibility for legacy
  // ADMIN accounts that have no adminRoleCodes yet (treated as SUPER_ADMIN).
  const {requireAdmin,permit}=createAdminGuard({getDb});
  r.use(requireAdmin);
  r.get('/overview',permit('trust.view'),async(req,res)=>res.json(await getTrust().overview()));
  r.get('/events',permit('trust.view'),async(req,res)=>{const q={};if(req.query.type)q.type=String(req.query.type);if(req.query.subjectType)q.subjectType=String(req.query.subjectType).toUpperCase();const rows=await getDb().collection('risk_events').find(q).sort({createdAt:-1}).limit(Math.min(300,Number(req.query.limit)||100)).toArray();res.json(rows.map(x=>({...x,_id:String(x._id),subjectId:String(x.subjectId),bookingId:x.bookingId?String(x.bookingId):null})));});
  r.get('/cases',permit('trust.view'),async(req,res)=>{const rows=await getDb().collection('fraud_cases').find(req.query.status?{status:String(req.query.status).toUpperCase()}:{ }).sort({createdAt:-1}).limit(150).toArray();res.json(rows.map(x=>({...x,_id:String(x._id),subjectId:String(x.subjectId),assignedAdminId:x.assignedAdminId?String(x.assignedAdminId):null})));});
  r.post('/cases/:id/action',permit('trust.review'),async(req,res)=>{const id=oid(req.params.id);const action=String(req.body?.action||'NOTE').toUpperCase();const now=new Date();const patch={updatedAt:now};if(action==='START_REVIEW')patch.status='IN_REVIEW';if(action==='RESOLVE')patch.status='RESOLVED';if(action==='DISMISS')patch.status='DISMISSED';await getDb().collection('fraud_cases').updateOne({_id:id},{$set:patch,$push:{actions:{action,note:req.body?.note||null,adminId:req.admin._id,createdAt:now}}});res.json({ok:true});});
  r.get('/verifications',permit('trust.view'),async(req,res)=>{const rows=await getDb().collection('identity_verifications').find({}).sort({createdAt:-1}).limit(150).toArray();res.json(rows.map(x=>({...x,_id:String(x._id),userId:String(x.userId),driverId:x.driverId?String(x.driverId):null})));});
  r.post('/verifications/:id/review',permit('trust.review'),async(req,res)=>{try{return res.json(await getTrust().reviewFace({verificationId:req.params.id,adminId:req.admin._id,decision:req.body?.decision,note:req.body?.note}));}catch(e){return res.status(400).json({message:e.message});}});
  r.get('/verifications/:id/evidence',permit('trust.review'),async(req,res)=>{try{const e=await getTrust().getFaceEvidence(req.params.id);if(!e)return res.status(404).json({message:'Không có ảnh evidence hoặc đã hết thời gian lưu.'});res.setHeader('Content-Type',e.mimeType);res.setHeader('Cache-Control','no-store');return res.send(e.buffer);}catch(err){return res.status(400).json({message:err.message});}});
  r.get('/devices',permit('trust.view'),async(req,res)=>{const rows=await getDb().collection('trusted_devices').find({}).sort({lastSeenAt:-1}).limit(200).toArray();res.json(rows.map(x=>({...x,_id:String(x._id),userId:String(x.userId)})));});
  r.post('/devices/:id/revoke',permit('trust.manage'),async(req,res)=>{await getDb().collection('trusted_devices').updateOne({_id:oid(req.params.id)},{$set:{status:'REVOKED',trusted:false,revokedBy:req.admin._id,revokedAt:new Date(),updatedAt:new Date()}});res.json({ok:true});});
  r.get('/rules',permit('trust.view'),async(req,res)=>{const rows=await getDb().collection('fraud_rules').find({}).sort({code:1}).toArray();res.json(rows.map(x=>({...x,_id:String(x._id)})));});
  r.put('/rules/:id',permit('trust.manage'),async(req,res)=>{const id=oid(req.params.id);const patch={updatedAt:new Date()};if('enabled'in req.body)patch.enabled=Boolean(req.body.enabled);if('weight'in req.body)patch.weight=Math.max(0,Math.min(100,Number(req.body.weight)||0));await getDb().collection('fraud_rules').updateOne({_id:id},{$set:patch});res.json({ok:true});});
  r.get('/profiles',permit('trust.view'),async(req,res)=>{const rows=await getDb().collection('trust_profiles').find({}).sort({riskScore:-1,updatedAt:-1}).limit(200).toArray();res.json(rows.map(x=>({...x,_id:String(x._id),subjectId:String(x.subjectId)})));});
  return r;
}
module.exports={createTrustRouter,createTrustAdminRouter};
