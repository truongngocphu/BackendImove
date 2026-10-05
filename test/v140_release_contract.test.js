const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('backend package and runtime advertise 1.4.0',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert.equal(pkg.version,'1.4.0');
  const server=read('src/server.js');
  assert.match(server,/version:\s*'1\.4\.0'/);
  const production=read('src/production_service.js');
  assert.match(production,/serverVersion:\s*'1\.4\.0'/);
});
