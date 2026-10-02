const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('backend runtime version follows package/env instead of stale hard-coded release',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert.match(pkg.version,/^1\.7\./);
  const server=read('src/server.js');
  assert.match(server,/APP_VERSION/);
  const production=read('src/production_service.js');
  assert.match(production,/PACKAGE_VERSION/);
  assert.doesNotMatch(production,/version:\s*'1\.4\.0'/);
});
