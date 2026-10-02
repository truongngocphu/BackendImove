const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeService,eligibleServiceCodes,SERVICE_CODES}=require('../src/service_catalog_service');
test('default catalog normalizes CAR_4',()=>{const r=normalizeService({code:'car_4',name:'Ô tô 4 chỗ',seats:4,status:'ACTIVE'});assert.equal(r.code,'CAR_4');assert.equal(r.seats,4);assert.equal(r.customerVisible,true)});
test('catalog contains required ride and commerce codes',()=>assert.deepEqual(SERVICE_CODES,['BIKE','DELIVERY','ERRAND','FOOD','CAR_4','CAR_7','MPV_7','LUXURY_4','LUXURY_7']));
test('vehicle eligibility is explicit',()=>{assert.deepEqual(eligibleServiceCodes({status:'APPROVED',serviceCodes:['CAR_7','MPV_7']}),['CAR_7','MPV_7']);assert.deepEqual(eligibleServiceCodes({status:'PENDING',serviceCodes:['CAR_7']}),[])});
