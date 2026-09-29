const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('backend package and runtime use one authoritative version',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert.equal(pkg.version,'1.6.0');
  const server=read('src/server.js');
  const production=read('src/production_service.js');
  assert.match(server,/APP_VERSION/);
  assert.match(production,/APP_VERSION/);
});
