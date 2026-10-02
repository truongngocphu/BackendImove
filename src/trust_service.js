const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const { paths: localPaths, relativeToProject, resolveProjectRelative } = require('./local_storage_service');

function bool(v, fallback=false){ if(v==null||v==='')return fallback; return ['1','true','yes','on'].includes(String(v).toLowerCase()); }
function num(v, fallback=0){ const n=Number(v); return Number.isFinite(n)?n:fallback; }
function oid(v){ try{return v instanceof ObjectId?v:new ObjectId(String(v));}catch(_){return null;} }
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
function haversineMeters(a,b){
  if(!a||!b)return null; const R=6371000,toRad=x=>x*Math.PI/180;
  const dLat=toRad(b.lat-a.lat),dLon=toRad(b.lng-a.lng);
  const q=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(q));
}

function evidenceKey(){
  const raw=String(process.env.FACE_EVIDENCE_KEY||process.env.KYC_DATA_KEY||'').trim();
  if(!raw)return null; if(/^[0-9a-fA-F]{64}$/.test(raw))return Buffer.from(raw,'hex'); return crypto.createHash('sha256').update(raw,'utf8').digest();
}
function encryptBuffer(buffer){
  const key=evidenceKey(); if(!key||!buffer?.length)return null; const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key,iv); const data=Buffer.concat([cipher.update(buffer),cipher.final()]); const tag=cipher.getAuthTag(); return {v:1,alg:'aes-256-gcm',iv,tag,data};
}
function decryptBuffer(payload){
  const key=evidenceKey(); if(!key||!payload)return null; const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(payload.iv.buffer||payload.iv)); decipher.setAuthTag(Buffer.from(payload.tag.buffer||payload.tag)); return Buffer.concat([decipher.update(Buffer.from(payload.data.buffer||payload.data)),decipher.final()]);
}

function encodeEncryptedEvidence(payload){
  if(!payload)return null;
  return JSON.stringify({
    v:payload.v||1,
    alg:payload.alg||'aes-256-gcm',
    iv:Buffer.from(payload.iv).toString('base64'),
    tag:Buffer.from(payload.tag).toString('base64'),
    data:Buffer.from(payload.data).toString('base64'),
  });
}
function decodeEncryptedEvidence(text){
  const row=JSON.parse(String(text||''));
  return {
    v:Number(row.v||1),
    alg:String(row.alg||'aes-256-gcm'),
    iv:Buffer.from(String(row.iv||''),'base64'),
    tag:Buffer.from(String(row.tag||''),'base64'),
    data:Buffer.from(String(row.data||''),'base64'),
  };
}
async function storeFaceEvidenceFile(buffer, verificationId){
  if(!buffer?.length)return null;
  const encrypted=encryptBuffer(buffer);
  if(!encrypted)throw new Error('FACE_EVIDENCE_KEY/KYC_DATA_KEY chưa được cấu hình để mã hóa ảnh khuôn mặt.');
  fs.mkdirSync(localPaths.faceEvidence,{recursive:true});
  const filename=`face-${String(verificationId)}-${crypto.randomBytes(8).toString('hex')}.imove`;
  const absolute=path.join(localPaths.faceEvidence,filename);
  await fs.promises.writeFile(absolute,encodeEncryptedEvidence(encrypted),{mode:0o600});
  return {relativePath:relativeToProject(absolute),storedName:filename,size:buffer.length};
}
async function loadFaceEvidenceFile(relativePath){
  if(!relativePath)return null;
  const absolute=resolveProjectRelative(relativePath,localPaths.faceEvidence);
  const text=await fs.promises.readFile(absolute,'utf8');
  return decryptBuffer(decodeEncryptedEvidence(text));
}

const DEFAULT_RULES=[
  ['NEW_DEVICE',12],['MULTI_ACCOUNT_DEVICE',25],['MULTI_DEVICE_DRIVER',15],['FACE_MISMATCH',45],['LIVENESS_FAILED',35],
  ['MOCK_GPS',45],['IMPOSSIBLE_SPEED',30],['IMPOSSIBLE_TRAVEL',35],['HIGH_CANCELLATION',18],['CANCEL_AFTER_ARRIVAL',25],
  ['SUSPECTED_OFF_PLATFORM_TRIP',30],['COLLUSION_PAIR',35],['APP_INTEGRITY_FAILED',40],['BIOMETRIC_NOT_VERIFIED',12]
];

function createTrustService({getDb, notificationService=null}){
  const faceThreshold=num(process.env.FACE_MATCH_MIN_SCORE,0.82);
  const liveThreshold=num(process.env.FACE_LIVENESS_MIN_SCORE,0.85);
  const reviewThreshold=num(process.env.TRUST_REVIEW_THRESHOLD,70);
  const stepUpThreshold=num(process.env.TRUST_STEP_UP_THRESHOLD,50);
  const restrictThreshold=num(process.env.TRUST_RESTRICT_THRESHOLD,85);
  const riskWindowDays=Math.max(7,num(process.env.TRUST_RISK_WINDOW_DAYS,90));
  const maxSpeedKmh=Math.max(80,num(process.env.TRUST_MAX_SPEED_KMH,180));
  const offPlatformNearMeters=Math.max(50,num(process.env.TRUST_OFF_PLATFORM_NEAR_METERS,250));

  async function databaseReady(){
    const db=getDb(); if(!db)return;
    await Promise.allSettled([
      db.collection('trusted_devices').createIndex({deviceId:1,userId:1,role:1},{unique:true,name:'uq_trusted_device_owner'}),
      db.collection('trusted_devices').createIndex({deviceId:1,lastSeenAt:-1},{name:'idx_device_reuse'}),
      db.collection('identity_challenges').createIndex({expiresAt:1},{expireAfterSeconds:0,name:'ttl_identity_challenge'}),
      db.collection('identity_verifications').createIndex({userId:1,role:1,createdAt:-1},{name:'idx_identity_verification'}),
      db.collection('face_evidence').createIndex({verificationId:1},{unique:true,name:'uq_face_evidence_verification'}),
      db.collection('face_evidence').createIndex({expiresAt:1},{expireAfterSeconds:0,name:'ttl_face_evidence'}),
      db.collection('risk_events').createIndex({subjectId:1,subjectType:1,createdAt:-1},{name:'idx_risk_subject'}),
      db.collection('risk_events').createIndex({bookingId:1,type:1,subjectId:1},{name:'idx_risk_booking'}),
      db.collection('fraud_cases').createIndex({caseCode:1},{unique:true,name:'uq_fraud_case_code'}),
      db.collection('fraud_cases').createIndex({subjectId:1,status:1,createdAt:-1},{name:'idx_fraud_subject'}),
      db.collection('fraud_rules').createIndex({code:1},{unique:true,name:'uq_fraud_rule'}),
      db.collection('trust_profiles').createIndex({subjectId:1,subjectType:1},{unique:true,name:'uq_trust_profile'}),
    ]);
    const now=new Date();
    for(const [code,weight] of DEFAULT_RULES){
      await db.collection('fraud_rules').updateOne({code},{$setOnInsert:{code,name:code.replaceAll('_',' '),enabled:true,weight,createdAt:now},$set:{updatedAt:now}},{upsert:true});
    }
  }

  async function ruleWeight(code,fallback){
    const r=await getDb().collection('fraud_rules').findOne({code});
    if(r&&r.enabled===false)return 0; return num(r?.weight,fallback);
  }

  async function score(subjectId,subjectType){
    const cutoff=new Date(Date.now()-riskWindowDays*86400000);
    const rows=await getDb().collection('risk_events').find({subjectId:oid(subjectId),subjectType:String(subjectType).toUpperCase(),status:{$ne:'DISMISSED'},createdAt:{$gte:cutoff}}).toArray();
    const total=clamp(rows.reduce((s,x)=>s+num(x.riskPoints),0),0,100);
    const level=total>=restrictThreshold?'RESTRICT':total>=reviewThreshold?'REVIEW':total>=stepUpThreshold?'STEP_UP':total>=30?'WATCH':'NORMAL';
    await getDb().collection('trust_profiles').updateOne({subjectId:oid(subjectId),subjectType:String(subjectType).toUpperCase()},{$set:{riskScore:total,riskLevel:level,eventCount:rows.length,updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},{upsert:true});
    return {riskScore:total,riskLevel:level,eventCount:rows.length};
  }

  async function ensureFraudCase({subjectId,subjectType,riskScore,triggerEventId=null}){
    if(riskScore<reviewThreshold)return null;
    const db=getDb(); const sid=oid(subjectId); const st=String(subjectType).toUpperCase();
    const existing=await db.collection('fraud_cases').findOne({subjectId:sid,subjectType:st,status:{$in:['OPEN','IN_REVIEW']}});
    if(existing){
      await db.collection('fraud_cases').updateOne({_id:existing._id},{$set:{riskScore,updatedAt:new Date()},...(triggerEventId?{$addToSet:{eventIds:oid(triggerEventId)}}:{})});
      return existing;
    }
    const doc={caseCode:`FR${new Date().toISOString().slice(0,10).replaceAll('-','')}${String(Date.now()).slice(-7)}`,subjectId:sid,subjectType:st,riskScore,priority:riskScore>=restrictThreshold?'CRITICAL':'HIGH',status:'OPEN',eventIds:triggerEventId?[oid(triggerEventId)]:[],assignedAdminId:null,actions:[],notes:[],createdAt:new Date(),updatedAt:new Date()};
    const r=await db.collection('fraud_cases').insertOne(doc); return {...doc,_id:r.insertedId};
  }

  async function addRiskEvent({subjectId,subjectType,type,severity='MEDIUM',bookingId=null,evidence={},dedupeKey=null,weight=null}){
    const db=getDb(); const sid=oid(subjectId); if(!sid)return null;
    const code=String(type).toUpperCase(); const fallback=weight==null?15:weight; const riskPoints=await ruleWeight(code,fallback);
    if(riskPoints<=0)return null;
    const filter=dedupeKey?{dedupeKey}:{subjectId:sid,subjectType:String(subjectType).toUpperCase(),type:code,bookingId:oid(bookingId)};
    if(dedupeKey){ const ex=await db.collection('risk_events').findOne(filter); if(ex)return ex; }
    const doc={subjectId:sid,subjectType:String(subjectType).toUpperCase(),type:code,severity,riskPoints,bookingId:oid(bookingId),evidence,status:'OPEN',dedupeKey:dedupeKey||null,createdAt:new Date(),updatedAt:new Date()};
    const r=await db.collection('risk_events').insertOne(doc); doc._id=r.insertedId;
    const s=await score(sid,subjectType); await ensureFraudCase({subjectId:sid,subjectType,riskScore:s.riskScore,triggerEventId:r.insertedId});
    return {...doc,score:s};
  }

  async function registerDevice({userId,role,deviceId,platform,model,osVersion,appVersion,integrity='UNKNOWN'}){
    const db=getDb(), uid=oid(userId), now=new Date(); if(!uid||!deviceId)throw new Error('Thiếu deviceId.');
    const device=String(deviceId);
    const sameDevice=await db.collection('trusted_devices').find({deviceId:device,userId:{$ne:uid},status:{$ne:'REVOKED'}}).limit(5).toArray();
    const existing=await db.collection('trusted_devices').findOne({deviceId:device,userId:uid,role:String(role).toUpperCase()});
    await db.collection('trusted_devices').updateOne({deviceId:device,userId:uid,role:String(role).toUpperCase()},{$set:{platform,model,osVersion,appVersion,integrity,lastSeenAt:now,status:existing?.status||'ACTIVE',trusted:existing?.trusted===true,updatedAt:now},$setOnInsert:{createdAt:now,biometricVerifiedAt:null,faceVerifiedAt:null}},{upsert:true});
    if(!existing) await addRiskEvent({subjectId:uid,subjectType:role,type:'NEW_DEVICE',severity:'LOW',dedupeKey:`NEW_DEVICE:${uid}:${device}`,evidence:{deviceId:device,model,platform}});
    if(sameDevice.length) await addRiskEvent({subjectId:uid,subjectType:role,type:'MULTI_ACCOUNT_DEVICE',severity:'HIGH',dedupeKey:`MULTI_ACCOUNT:${uid}:${device}`,evidence:{deviceId:device,otherAccounts:sameDevice.map(x=>String(x.userId))}});
    if(String(role).toUpperCase()==='DRIVER'){
      const active=await db.collection('trusted_devices').countDocuments({userId:uid,role:'DRIVER',status:{$ne:'REVOKED'}});
      if(active>2) await addRiskEvent({subjectId:uid,subjectType:'DRIVER',type:'MULTI_DEVICE_DRIVER',severity:'MEDIUM',dedupeKey:`MULTI_DEVICE_DRIVER:${uid}:${new Date().toISOString().slice(0,10)}`,evidence:{activeDevices:active}});
    }
    return {ok:true,deviceId:device,newDevice:!existing,risk:await score(uid,role)};
  }

  async function markBiometric({userId,role,deviceId}){
    const db=getDb(), uid=oid(userId), now=new Date();
    await db.collection('trusted_devices').updateOne({userId:uid,role:String(role).toUpperCase(),deviceId:String(deviceId)},{$set:{biometricVerifiedAt:now,lastSeenAt:now,updatedAt:now}});
    return {ok:true,verifiedAt:now};
  }

  async function createFaceChallenge({userId,driverId=null,trigger='GO_ONLINE'}){
    const db=getDb(); const actions=['LOOK_STRAIGHT','TURN_LEFT','TURN_RIGHT','BLINK'];
    const rotate=Math.floor(Math.random()*actions.length); const ordered=[...actions.slice(rotate),...actions.slice(0,rotate)].slice(0,3);
    const doc={userId:oid(userId),driverId:oid(driverId),trigger:String(trigger),nonce:crypto.randomBytes(18).toString('hex'),actions:ordered,status:'OPEN',createdAt:new Date(),expiresAt:new Date(Date.now()+5*60*1000)};
    const r=await db.collection('identity_challenges').insertOne(doc); return {challengeId:String(r.insertedId),nonce:doc.nonce,actions:ordered,expiresAt:doc.expiresAt};
  }

  async function completeFace({challengeId,userId,role='DRIVER',imageBuffer=null,imageMime='image/jpeg',deviceId=null,actionsCompleted=[],providerScores=null}){
    const db=getDb(), cid=oid(challengeId), uid=oid(userId), now=new Date(); if(!cid)throw new Error('Challenge không hợp lệ.');
    const ch=await db.collection('identity_challenges').findOne({_id:cid,userId:uid,status:'OPEN',expiresAt:{$gt:now}}); if(!ch)throw new Error('Face challenge đã hết hạn hoặc không hợp lệ.');
    const mode=String(process.env.FACE_PROVIDER_MODE||'MANUAL').toUpperCase();
    const evidenceHash=imageBuffer?.length?crypto.createHash('sha256').update(imageBuffer).digest('hex'):null;
    let livenessScore=num(providerScores?.livenessScore,0), faceMatchScore=num(providerScores?.faceMatchScore,0), status='REVIEW_REQUIRED';
    if(mode==='DEV' && String(process.env.NODE_ENV||'development').toLowerCase()!=='production'){
      livenessScore=imageBuffer?.length>5000?0.96:0.3; faceMatchScore=imageBuffer?.length>5000?0.93:0.3; status=livenessScore>=liveThreshold&&faceMatchScore>=faceThreshold?'PASSED':'FAILED';
    } else if(mode==='TRUSTED'){
      status=livenessScore>=liveThreshold&&faceMatchScore>=faceThreshold?'PASSED':'FAILED';
    }
    const doc={userId:uid,driverId:ch.driverId||null,role:String(role).toUpperCase(),type:'FACE_LIVENESS',trigger:ch.trigger,status,livenessScore,faceMatchScore,actionsExpected:ch.actions,actionsCompleted:Array.isArray(actionsCompleted)?actionsCompleted:[],evidenceHash,deviceId:deviceId||null,providerMode:mode,createdAt:now,updatedAt:now};
    const r=await db.collection('identity_verifications').insertOne(doc);
    const storedEvidence=await storeFaceEvidenceFile(imageBuffer,r.insertedId);
    if(storedEvidence){
      const retentionDays=Math.max(1,num(process.env.FACE_EVIDENCE_RETENTION_DAYS,30));
      await db.collection('face_evidence').updateOne(
        {verificationId:r.insertedId},
        {$set:{
          verificationId:r.insertedId,
          userId:uid,
          mimeType:imageMime||'image/jpeg',
          storage:'PRIVATE_LOCAL_ENCRYPTED',
          relativePath:storedEvidence.relativePath,
          storedName:storedEvidence.storedName,
          size:storedEvidence.size,
          createdAt:now,
          expiresAt:new Date(Date.now()+retentionDays*86400000),
        },$unset:{encrypted:''}},
        {upsert:true},
      );
    }
    await db.collection('identity_challenges').updateOne({_id:cid},{$set:{status:'USED',usedAt:now}});
    if(status==='PASSED'){
      if(deviceId) await db.collection('trusted_devices').updateOne({userId:uid,deviceId:String(deviceId)},{$set:{trusted:true,faceVerifiedAt:now,updatedAt:now}});
    } else if(status==='FAILED'){
      await addRiskEvent({subjectId:uid,subjectType:role,type:livenessScore<liveThreshold?'LIVENESS_FAILED':'FACE_MISMATCH',severity:'HIGH',dedupeKey:`FACE_FAIL:${r.insertedId}`,evidence:{livenessScore,faceMatchScore,verificationId:String(r.insertedId)}});
    }
    return {verificationId:String(r.insertedId),status,livenessScore,faceMatchScore,reviewRequired:status==='REVIEW_REQUIRED'};
  }

  async function reviewFace({verificationId,adminId,decision,note}){
    const db=getDb(), id=oid(verificationId), now=new Date(); const status=String(decision).toUpperCase()==='APPROVE'?'PASSED':'FAILED';
    const v=await db.collection('identity_verifications').findOne({_id:id}); if(!v)throw new Error('Không tìm thấy xác thực.');
    await db.collection('identity_verifications').updateOne({_id:id},{$set:{status,reviewedBy:oid(adminId),reviewedAt:now,reviewNote:note||null,updatedAt:now}});
    if(status==='PASSED'&&v.deviceId)await db.collection('trusted_devices').updateOne({userId:v.userId,deviceId:v.deviceId},{$set:{trusted:true,faceVerifiedAt:now,updatedAt:now}});
    if(status==='FAILED')await addRiskEvent({subjectId:v.userId,subjectType:v.role,type:'FACE_MISMATCH',severity:'HIGH',dedupeKey:`FACE_REJECT:${id}`,evidence:{verificationId:String(id),note}});
    return {ok:true,status};
  }

  async function analyzeLocation({driverId,userId,lat,lng,isMocked=false,accuracy=null,timestamp=null}){
    const db=getDb(), did=oid(driverId), uid=oid(userId), now=new Date(), point={lat:num(lat),lng:num(lng)};
    const profile=await db.collection('trust_profiles').findOne({subjectId:uid,subjectType:'DRIVER'});
    if(isMocked)await addRiskEvent({subjectId:uid,subjectType:'DRIVER',type:'MOCK_GPS',severity:'CRITICAL',dedupeKey:`MOCK_GPS:${uid}:${Math.floor(Date.now()/60000)}`,evidence:{lat:point.lat,lng:point.lng,accuracy}});
    const last=profile?.lastLocation;
    if(last?.lat!=null&&last?.lng!=null&&last?.at){
      const meters=haversineMeters({lat:num(last.lat),lng:num(last.lng)},point); const seconds=Math.max(1,(now-new Date(last.at))/1000); const kmh=(meters/seconds)*3.6;
      if(kmh>maxSpeedKmh)await addRiskEvent({subjectId:uid,subjectType:'DRIVER',type:'IMPOSSIBLE_SPEED',severity:kmh>400?'CRITICAL':'HIGH',dedupeKey:`SPEED:${uid}:${Math.floor(Date.now()/60000)}`,evidence:{kmh:Math.round(kmh),distanceMeters:Math.round(meters),seconds}});
    }
    await db.collection('trust_profiles').updateOne({subjectId:uid,subjectType:'DRIVER'},{$set:{lastLocation:{...point,at:timestamp?new Date(timestamp):now,accuracy},driverId:did,updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});
    return {ok:true,risk:await score(uid,'DRIVER')};
  }

  async function analyzeCancellation({booking,actorType,driverId=null,driverUserId=null,reason}){
    if(!booking)return null; const db=getDb(); const stage=String(booking.status||''); const pickupCoords=booking.pickup?.location?.coordinates;
    let distanceMeters=null;
    if(driverId&&Array.isArray(pickupCoords)){
      const loc=await db.collection('driver_locations').findOne({driverId:oid(driverId)});
      const coords=loc?.location?.coordinates; if(Array.isArray(coords))distanceMeters=haversineMeters({lat:num(coords[1]),lng:num(coords[0])},{lat:num(pickupCoords[1]),lng:num(pickupCoords[0])});
    }
    const near=distanceMeters!=null&&distanceMeters<=offPlatformNearMeters; const afterArrival=['DRIVER_ARRIVED','IN_PROGRESS'].includes(stage);
    const subjectId=actorType==='DRIVER'?oid(driverUserId||driverId):booking.customerId; const subjectType=actorType==='DRIVER'?'DRIVER':'CUSTOMER';
    if(afterArrival||near){
      await addRiskEvent({subjectId,subjectType,type:'CANCEL_AFTER_ARRIVAL',severity:'HIGH',bookingId:booking._id,dedupeKey:`CANCEL_AFTER_ARRIVAL:${booking._id}:${subjectType}`,evidence:{stage,distanceMeters:distanceMeters==null?null:Math.round(distanceMeters),reason,pairDriverId:driverId?String(driverId):null,pairCustomerId:booking.customerId?String(booking.customerId):null}});
      await addRiskEvent({subjectId,subjectType,type:'SUSPECTED_OFF_PLATFORM_TRIP',severity:'HIGH',bookingId:booking._id,dedupeKey:`OFFPLATFORM:${booking._id}:${subjectType}`,evidence:{stage,distanceMeters:distanceMeters==null?null:Math.round(distanceMeters),reason,pairDriverId:driverId?String(driverId):null,pairCustomerId:booking.customerId?String(booking.customerId):null}});
    }
    if(actorType==='DRIVER'&&driverUserId){
      const startDay=new Date(); startDay.setHours(0,0,0,0);
      const cancels=await db.collection('booking_events').countDocuments({actorId:oid(driverId),type:{$in:['CANCELLED_BY_DRIVER','DRIVER_CANCEL_REQUEUE']},createdAt:{$gte:startDay}});
      if(cancels>=5) await addRiskEvent({subjectId:oid(driverUserId),subjectType:'DRIVER',type:'HIGH_CANCELLATION',severity:'HIGH',dedupeKey:`HIGH_CANCEL:${driverUserId}:${startDay.toISOString().slice(0,10)}`,evidence:{todayCancels:cancels}});
    }
    if(driverId&&booking.customerId){
      const pairCount=await db.collection('risk_events').countDocuments({type:'SUSPECTED_OFF_PLATFORM_TRIP','evidence.pairDriverId':String(driverId),'evidence.pairCustomerId':String(booking.customerId),createdAt:{$gte:new Date(Date.now()-30*86400000)}});
      if(pairCount>=2){
        await addRiskEvent({subjectId:oid(driverUserId||driverId),subjectType:'DRIVER',type:'COLLUSION_PAIR',severity:'CRITICAL',dedupeKey:`COLLUSION:${driverId}:${booking.customerId}:${new Date().toISOString().slice(0,10)}`,evidence:{pairDriverId:String(driverId),pairCustomerId:String(booking.customerId),pairCount:pairCount+1}});
      }
    }
    return {ok:true};
  }

  async function loadRuntimeSecurityPolicy(){
    const defaults={
      securityMode:'PRODUCTION',
      securityPolicyVersion:2,
      securityPolicy:{
        enforceKyc:true,
        enforceRiskRestriction:true,
        requireFcm:true,
        requireTrustedDevice:true,
        requireIntegrity:true,
        requireFace:true,
        requireBiometric:true,
      },
    };
    const db=getDb();
    if(!db) return defaults;
    const row=await db.collection('app_settings').findOne({key:'V73_PRODUCTION_CONFIG'});
    const mode=String(row?.value?.securityMode||defaults.securityMode).toUpperCase()==='TEST'?'TEST':'PRODUCTION';
    const version=num(row?.value?.securityPolicyVersion,0);
    const raw=row?.value?.securityPolicy||{};
    const migrated=mode==='TEST'&&version<2?{requireFcm:false,requireTrustedDevice:false,requireIntegrity:false,requireFace:false,requireBiometric:false}:{};
    const policy={...defaults.securityPolicy,...raw,...migrated};
    return {
      securityMode:mode,
      securityPolicyVersion:2,
      securityPolicy:{
        enforceKyc:Boolean(policy.enforceKyc),
        enforceRiskRestriction:Boolean(policy.enforceRiskRestriction),
        requireFcm:Boolean(policy.requireFcm),
        requireTrustedDevice:Boolean(policy.requireTrustedDevice),
        requireIntegrity:Boolean(policy.requireIntegrity),
        requireFace:Boolean(policy.requireFace),
        requireBiometric:Boolean(policy.requireBiometric),
      },
    };
  }

  async function driverTrustStatus({driver,user}){
    const runtime=await loadRuntimeSecurityPolicy();
    const policy=runtime.securityPolicy;
    const s=await score(user._id,'DRIVER');
    const devices=await getDb().collection('trusted_devices').find({userId:user._id,role:'DRIVER',status:{$ne:'REVOKED'}}).sort({lastSeenAt:-1}).toArray();
    const lastFace=await getDb().collection('identity_verifications').findOne({userId:user._id,role:'DRIVER',status:'PASSED'},{sort:{createdAt:-1}});
    const faceAgeHours=lastFace?(Date.now()-new Date(lastFace.createdAt).getTime())/3600000:9999;
    const maxFaceHours=Math.max(1,num(process.env.DRIVER_FACE_VALID_HOURS,12));
    const requiresFaceCheck=policy.requireFace && (s.riskScore>=stepUpThreshold||faceAgeHours>maxFaceHours||devices.some(d=>d.trusted!==true));
    const integrityVerified=devices.some(d=>['VERIFIED','PLAY_INTEGRITY_OK','APP_CHECK_VERIFIED'].includes(String(d.integrity||'').toUpperCase())&&new Date(d.lastSeenAt||0).getTime()>Date.now()-24*3600000);
    return {...s,securityMode:runtime.securityMode,securityPolicy:policy,requiresFaceCheck,restricted:policy.enforceRiskRestriction&&s.riskScore>=restrictThreshold,integrityVerified,lastFaceAt:lastFace?.createdAt||null,deviceCount:devices.length};
  }

  async function canDriverGoOnline({driver,user}){
    const st=await driverTrustStatus({driver,user});
    if(st.restricted)return {ok:false,code:'TRUST_RESTRICTED',message:'Tài khoản đang được Trust & Safety kiểm tra.',...st};
    if(st.securityPolicy?.requireIntegrity && !st.integrityVerified)return {ok:false,code:'APP_INTEGRITY_REQUIRED',message:'Không xác minh được bản cài đặt iMove Driver chính thức.',...st};
    if(st.securityPolicy?.requireFace && st.requiresFaceCheck)return {ok:false,code:'FACE_VERIFICATION_REQUIRED',message:'Vui lòng xác thực khuôn mặt trước khi Online.',...st};
    return {ok:true,...st};
  }

  async function getFaceEvidence(verificationId){
    const id=oid(verificationId);
    if(!id)return null;
    const doc=await getDb().collection('face_evidence').findOne({verificationId:id});
    if(!doc)return null;
    let buffer=null;
    if(doc.relativePath){
      try{buffer=await loadFaceEvidenceFile(doc.relativePath);}catch(_){buffer=null;}
    }
    // Backward compatibility: evidence created before LOCAL storage migration.
    if(!buffer&&doc.encrypted)buffer=decryptBuffer(doc.encrypted);
    return buffer?{buffer,mimeType:doc.mimeType||'image/jpeg'}:null;
  }

  async function overview(){
    const db=getDb(); const start=new Date(); start.setHours(0,0,0,0);
    const [today,high,openCases,facePending,mockGps,offPlatform,restricted]=await Promise.all([
      db.collection('risk_events').countDocuments({createdAt:{$gte:start}}),
      db.collection('risk_events').countDocuments({createdAt:{$gte:start},severity:{$in:['HIGH','CRITICAL']}}),
      db.collection('fraud_cases').countDocuments({status:{$in:['OPEN','IN_REVIEW']}}),
      db.collection('identity_verifications').countDocuments({status:'REVIEW_REQUIRED'}),
      db.collection('risk_events').countDocuments({createdAt:{$gte:start},type:'MOCK_GPS'}),
      db.collection('risk_events').countDocuments({createdAt:{$gte:start},type:'SUSPECTED_OFF_PLATFORM_TRIP'}),
      db.collection('trust_profiles').countDocuments({riskScore:{$gte:restrictThreshold}}),
    ]); return {todayRiskEvents:today,highRiskEvents:high,openCases,facePending,mockGps,offPlatform,restricted,thresholds:{stepUpThreshold,reviewThreshold,restrictThreshold}};
  }

  return {databaseReady,addRiskEvent,score,registerDevice,markBiometric,createFaceChallenge,completeFace,reviewFace,getFaceEvidence,analyzeLocation,analyzeCancellation,driverTrustStatus,canDriverGoOnline,overview,ensureFraudCase};
}
module.exports={createTrustService};
