
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { createAuthenticate } = require('./auth_routes');
const { createAdminGuard } = require('./admin_guard');
const { paths: localPaths, randomStoredName, resolveInside, removeFileQuiet } = require('./local_storage_service');
const {
  createAdminPointAdjustment,
  pointValueVnd,
} = require('./driver_points_service');

function oid(value){try{return value instanceof ObjectId?value:new ObjectId(String(value));}catch(_){return null;}}
function clean(value,max=240){return String(value??'').trim().slice(0,max);}
function digits(value){return String(value??'').replace(/\D/g,'');}
function amount(value){const n=Math.round(Number(value));return Number.isFinite(n)?n:0;}
function publicBankConfig(doc={}){
  return {
    bankName: clean(doc.bankName || process.env.COMPANY_BANK_NAME,120),
    accountNumber: clean(doc.accountNumber || process.env.COMPANY_BANK_ACCOUNT,80),
    accountName: clean(doc.accountName || process.env.COMPANY_BANK_ACCOUNT_NAME,160),
    branch: clean(doc.branch || process.env.COMPANY_BANK_BRANCH,160),
    qrImageUrl: doc.qrStoredName ? '/api/v171/funds/qr' : clean(doc.qrImageUrl,500),
    updatedAt: doc.updatedAt || null,
  };
}
function transferContent(actorType, phone, code){
  const prefix=actorType==='MERCHANT'?'TH79 MER':'TH79 DRV';
  return `${prefix} ${digits(phone).slice(-6)} ${code}`.replace(/\s+/g,' ').trim();
}
function serialize(row){
  if(!row)return row;
  return {
    id:String(row._id),
    actorType:row.actorType,
    actorUserId:row.actorUserId?String(row.actorUserId):null,
    targetId:row.targetId?String(row.targetId):null,
    fundType:row.fundType,
    amountVnd:row.amountVnd,
    points:row.points||0,
    requestCode:row.requestCode,
    transferCode:row.requestCode,
    transferContent:row.transferContent,
    status:row.status,
    receiptUploaded:Boolean(row.receiptStoredName),
    receiptOriginalName:row.receiptOriginalName||null,
    receiptUrl:row.receiptStoredName?`/api/v171/admin/funds/requests/${String(row._id)}/receipt`:null,
    note:row.note||'',
    rejectReason:row.rejectReason||'',
    actorSnapshot:row.actorSnapshot||null,
    createdAt:row.createdAt,
    updatedAt:row.updatedAt,
    approvedAt:row.approvedAt||null,
    rejectedAt:row.rejectedAt||null,
  };
}
function makeStorage(folder){
  fs.mkdirSync(folder,{recursive:true});
  return multer.diskStorage({
    destination:(_req,_file,cb)=>cb(null,folder),
    filename:(_req,file,cb)=>{
      cb(null,randomStoredName(file,'fund'));
    },
  });
}
function imageFilter(_req,file,cb){
  if(/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.mimetype))return cb(null,true);
  cb(new Error('Chỉ chấp nhận ảnh JPEG/PNG/WEBP/HEIC.'));
}
const receiptRoot=localPaths.fundReceipts;
const qrRoot=localPaths.fundQr;
const receiptMaxMb=Math.max(1,Math.min(20,Number(process.env.FUND_RECEIPT_MAX_FILE_MB||8)));
const qrMaxMb=Math.max(1,Math.min(10,Number(process.env.FUND_QR_MAX_FILE_MB||5)));
const receiptUpload=multer({storage:makeStorage(receiptRoot),limits:{fileSize:receiptMaxMb*1024*1024},fileFilter:imageFilter});
const qrUpload=multer({storage:makeStorage(qrRoot),limits:{fileSize:qrMaxMb*1024*1024},fileFilter:imageFilter});

async function actorContext(db,user){
  const roles=Array.isArray(user.roles)?user.roles.map(x=>String(x).toUpperCase()):[];
  if(roles.includes('DRIVER')){
    const driver=await db.collection('drivers').findOne({userId:user._id});
    if(!driver)throw Object.assign(new Error('Không tìm thấy hồ sơ tài xế.'),{httpStatus:404});
    return {actorType:'DRIVER',targetId:driver._id,fundType:'DRIVER_POINTS',snapshot:{fullName:user.fullName||driver.fullName||'Tài xế',phone:user.phone||driver.phone||''}};
  }
  if(roles.includes('MERCHANT')){
    const membership=await db.collection('merchant_users').findOne({userId:user._id});
    if(!membership)throw Object.assign(new Error('Tài khoản chưa được gán cửa hàng.'),{httpStatus:403});
    const merchant=await db.collection('merchants').findOne({_id:membership.merchantId});
    if(!merchant)throw Object.assign(new Error('Không tìm thấy cửa hàng.'),{httpStatus:404});
    return {actorType:'MERCHANT',targetId:merchant._id,fundType:'MERCHANT_DEPOSIT',snapshot:{fullName:merchant.name||user.fullName||'Merchant',phone:merchant.phone||user.phone||''}};
  }
  throw Object.assign(new Error('Tài khoản không thuộc Driver hoặc Merchant.'),{httpStatus:403});
}

function createFundTopupRouter({getDb}){
  const r=express.Router();
  const authenticate=createAuthenticate(getDb);
  r.get('/qr',async(_req,res)=>{
    const doc=await getDb()?.collection('fund_settings').findOne({_id:'BANK_TRANSFER'}).catch(()=>null);
    if(!doc?.qrStoredName)return res.status(404).end();
    const file=resolveInside(qrRoot,path.basename(doc.qrStoredName));
    if(!fs.existsSync(file))return res.status(404).end();
    res.setHeader('Cache-Control','public, max-age=300');
    return res.sendFile(file);
  });

  r.use(authenticate);

  r.get('/config',async(req,res)=>{
    const db=getDb();
    const [doc,ctx]=await Promise.all([
      db.collection('fund_settings').findOne({_id:'BANK_TRANSFER'}),
      actorContext(db,req.auth.user),
    ]);
    return res.json({
      bank:publicBankConfig(doc||{}),
      actorType:ctx.actorType,
      fundType:ctx.fundType,
      minimumAmountVnd:Math.max(10000,Number(doc?.minimumAmountVnd||50000)),
      pointValueVnd:ctx.actorType==='DRIVER'?pointValueVnd():null,
    });
  });

  r.get('/requests',async(req,res)=>{
    const db=getDb();
    const ctx=await actorContext(db,req.auth.user);
    const rows=await db.collection('fund_topup_requests')
      .find({actorUserId:req.auth.user._id,targetId:ctx.targetId})
      .sort({createdAt:-1}).limit(100).toArray();
    return res.json({requests:rows.map(serialize)});
  });

  r.post('/requests',async(req,res)=>{
    try{
      const db=getDb();
      const ctx=await actorContext(db,req.auth.user);
      const setting=await db.collection('fund_settings').findOne({_id:'BANK_TRANSFER'});
      const min=Math.max(10000,Number(setting?.minimumAmountVnd||50000));
      const value=amount(req.body?.amountVnd);
      if(value<min)return res.status(400).json({message:`Số tiền tối thiểu ${min.toLocaleString('vi-VN')}đ.`});
      const now=new Date();
      const requestCode=`F${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const content=transferContent(ctx.actorType,ctx.snapshot.phone,requestCode);
      const doc={
        actorType:ctx.actorType,
        actorUserId:req.auth.user._id,
        targetId:ctx.targetId,
        fundType:ctx.fundType,
        actorSnapshot:ctx.snapshot,
        amountVnd:value,
        points:ctx.actorType==='DRIVER'?Math.floor(value/pointValueVnd()):0,
        requestCode,
        transferContent:content,
        status:'WAITING_TRANSFER',
        note:clean(req.body?.note,500),
        createdAt:now,updatedAt:now,
      };
      const result=await db.collection('fund_topup_requests').insertOne(doc);
      doc._id=result.insertedId;
      return res.status(201).json({request:serialize(doc),bank:publicBankConfig(setting||{})});
    }catch(e){return res.status(Number(e.httpStatus)||500).json({message:e.message});}
  });

  r.post('/requests/:id/receipt',receiptUpload.single('receipt'),async(req,res)=>{
    try{
      const db=getDb(), id=oid(req.params.id);
      if(!id)return res.status(400).json({message:'ID không hợp lệ.'});
      const row=await db.collection('fund_topup_requests').findOne({_id:id,actorUserId:req.auth.user._id});
      if(!row)return res.status(404).json({message:'Không tìm thấy yêu cầu.'});
      if(!req.file)return res.status(400).json({message:'Vui lòng chọn ảnh biên lai.'});
      const now=new Date();
      await db.collection('fund_topup_requests').updateOne({_id:id},{
        $set:{
          receiptStoredName:req.file.filename,
          receiptOriginalName:clean(req.file.originalname,240),
          receiptMime:req.file.mimetype,
          status:'PENDING_REVIEW',
          submittedAt:now,updatedAt:now,
        }
      });
      const updated=await db.collection('fund_topup_requests').findOne({_id:id});
      return res.json({request:serialize(updated)});
    }catch(e){return res.status(500).json({message:e.message});}
  });
  return r;
}

function createFundTopupAdminRouter({getDb}){
  const r=express.Router();
  const {requireAdmin,permit}=createAdminGuard({getDb});
  r.use(requireAdmin);

  r.get('/config',permit('settings.view'),async(_req,res)=>{
    const doc=await getDb().collection('fund_settings').findOne({_id:'BANK_TRANSFER'});
    return res.json({bank:publicBankConfig(doc||{}),minimumAmountVnd:Number(doc?.minimumAmountVnd||50000)});
  });
  r.put('/config',permit('settings.manage'),async(req,res)=>{
    const now=new Date();
    const patch={
      bankName:clean(req.body?.bankName,120),
      accountNumber:clean(req.body?.accountNumber,80),
      accountName:clean(req.body?.accountName,160),
      branch:clean(req.body?.branch,160),
      qrImageUrl:clean(req.body?.qrImageUrl,500),
      minimumAmountVnd:Math.max(10000,amount(req.body?.minimumAmountVnd||50000)),
      updatedAt:now,
      updatedBy:req.admin._id,
    };
    await getDb().collection('fund_settings').updateOne({_id:'BANK_TRANSFER'},{$set:patch,$setOnInsert:{createdAt:now}},{upsert:true});
    await getDb().collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'FUND_BANK_CONFIG_UPDATE',entityType:'FUND_SETTINGS',entityId:'BANK_TRANSFER',after:patch,createdAt:now});
    const doc=await getDb().collection('fund_settings').findOne({_id:'BANK_TRANSFER'});
    return res.json({bank:publicBankConfig(doc),minimumAmountVnd:doc.minimumAmountVnd});
  });
  r.post('/config/qr',permit('settings.manage'),qrUpload.single('qr'),async(req,res)=>{
    if(!req.file)return res.status(400).json({message:'Vui lòng chọn ảnh QR.'});
    const db=getDb(),now=new Date();
    const old=await db.collection('fund_settings').findOne({_id:'BANK_TRANSFER'});
    if(old?.qrStoredName){
      removeFileQuiet(resolveInside(qrRoot,path.basename(old.qrStoredName)),qrRoot).catch(()=>{});
    }
    await db.collection('fund_settings').updateOne({_id:'BANK_TRANSFER'},{$set:{qrStoredName:req.file.filename,qrImageUrl:'',updatedAt:now,updatedBy:req.admin._id},$setOnInsert:{createdAt:now}},{upsert:true});
    return res.json({ok:true,qrImageUrl:'/api/v171/funds/qr'});
  });
  r.get('/requests',permit('settings.view'),async(req,res)=>{
    const q={};
    const status=clean(req.query.status,40).toUpperCase();
    const actorType=clean(req.query.actorType,20).toUpperCase();
    if(status&&status!=='ALL')q.status=status;
    if(actorType&&actorType!=='ALL')q.actorType=actorType;
    const rows=await getDb().collection('fund_topup_requests').find(q).sort({createdAt:-1}).limit(500).toArray();
    return res.json({requests:rows.map(serialize)});
  });
  r.get('/requests/:id/receipt',permit('settings.view'),async(req,res)=>{
    const id=oid(req.params.id);
    const row=id?await getDb().collection('fund_topup_requests').findOne({_id:id}):null;
    if(!row?.receiptStoredName)return res.status(404).end();
    const file=resolveInside(receiptRoot,path.basename(row.receiptStoredName));
    if(!fs.existsSync(file))return res.status(404).end();
    res.setHeader('Content-Type',row.receiptMime||'application/octet-stream');
    return res.sendFile(file);
  });
  r.post('/requests/:id/approve',permit('settings.manage'),async(req,res)=>{
    const db=getDb(),id=oid(req.params.id);
    const row=id?await db.collection('fund_topup_requests').findOne({_id:id}):null;
    if(!row)return res.status(404).json({message:'Không tìm thấy yêu cầu.'});
    if(row.status==='APPROVED')return res.json({request:serialize(row),duplicate:true});
    if(!['PENDING_REVIEW','WAITING_TRANSFER'].includes(row.status))return res.status(409).json({message:'Trạng thái yêu cầu không thể duyệt.'});
    const now=new Date();
    if(row.actorType==='DRIVER'){
      const points=Math.max(1,Math.floor(Number(row.amountVnd||0)/pointValueVnd()));
      await createAdminPointAdjustment(db,{
        driverId:row.targetId,
        points,
        reason:'Duyệt nạp quỹ điểm qua chuyển khoản',
        reference:row.requestCode,
        adminId:req.admin._id,
        idempotencyKey:`fund-topup-${String(row._id)}`,
      });
    }else if(row.actorType==='MERCHANT'){
      await db.collection('merchant_fund_transactions').updateOne(
        {sourceRequestId:row._id},
        {$setOnInsert:{
          merchantId:row.targetId,userId:row.actorUserId,sourceRequestId:row._id,
          type:'TOPUP',amountVnd:Number(row.amountVnd||0),direction:'CREDIT',
          title:'Nạp quỹ Merchant',reference:row.requestCode,adminId:req.admin._id,createdAt:now
        }},
        {upsert:true},
      );
      const total=await db.collection('merchant_fund_transactions').aggregate([
        {$match:{merchantId:row.targetId}},
        {$group:{_id:null,balance:{$sum:'$amountVnd'}}},
      ]).toArray();
      await db.collection('merchant_fund_accounts').updateOne(
        {merchantId:row.targetId},
        {$set:{merchantId:row.targetId,balance:Number(total[0]?.balance||0),updatedAt:now},$setOnInsert:{createdAt:now}},
        {upsert:true},
      );
    }
    await db.collection('fund_topup_requests').updateOne({_id:row._id},{$set:{status:'APPROVED',approvedAt:now,approvedBy:req.admin._id,updatedAt:now}});
    await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'FUND_TOPUP_APPROVE',entityType:'FUND_TOPUP',entityId:String(row._id),after:{actorType:row.actorType,amountVnd:row.amountVnd,requestCode:row.requestCode},createdAt:now});
    return res.json({request:serialize(await db.collection('fund_topup_requests').findOne({_id:row._id}))});
  });
  r.post('/requests/:id/reject',permit('settings.manage'),async(req,res)=>{
    const db=getDb(),id=oid(req.params.id),now=new Date();
    const row=id?await db.collection('fund_topup_requests').findOne({_id:id}):null;
    if(!row)return res.status(404).json({message:'Không tìm thấy yêu cầu.'});
    const reason=clean(req.body?.reason,500)||'Không đối chiếu được giao dịch.';
    await db.collection('fund_topup_requests').updateOne({_id:id},{$set:{status:'REJECTED',rejectReason:reason,rejectedAt:now,rejectedBy:req.admin._id,updatedAt:now}});
    return res.json({request:serialize(await db.collection('fund_topup_requests').findOne({_id:id}))});
  });
  return r;
}

module.exports={createFundTopupRouter,createFundTopupAdminRouter};
