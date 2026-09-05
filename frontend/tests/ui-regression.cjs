// Local browser regression with controlled RPC/AI fixtures; no live chain or wallet calls.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const a = '0x' + '1'.repeat(64), b = '0x' + '2'.repeat(64), wrong = '0x' + '3'.repeat(64);
function object(id) {
  return { data: { objectId: id, content: { dataType:'moveObject', type:id === wrong ? '0x2::coin::Coin<0x2::sui::SUI>' : '0x123::batch::Batch', fields: {
    batch_code:id === a ? 'BATCH-A' : 'BATCH-B', product_name:id === a ? 'Product A' : 'Product B',
    manufacturer:'0x'+'4'.repeat(64), created_at_ms:'1000', expiry_ms:'1900000000000',
    checkpoints:[], hold_history:[], is_held:false,
  }}} };
}
(async () => {
 const server = spawn(process.execPath, [path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5189','--strictPort'], {
    cwd:root, env:{...process.env,VITE_PACKAGE_ID:'0x123',VITE_TYPE_PACKAGE_ID:'0x123'}, windowsHide:true, stdio:['ignore','pipe','pipe'],
 });
 let browser;
 try {
   await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(d.toString().includes('127.0.0.1'))resolve()});server.once('error',reject);server.once('exit',c=>reject(Error('Vite exited '+c)));});
   browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL || 'msedge',headless:true});
   const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*publicnode.com/**',async route=>{
     const req=route.request().postDataJSON();
     if (req.method === 'sui_getObject' && req.params[0] === '0x'+'5'.repeat(64)) {
       return route.fulfill({json:{jsonrpc:'2.0',id:req.id,error:{code:-32603,message:'Fixture RPC unavailable'}}});
     }
     const result=req.method==='sui_getObject'?object(req.params[0]):{data:[],hasNextPage:false,nextCursor:null};
     await route.fulfill({json:{jsonrpc:'2.0',id:req.id,result}});
   });
   let hold=true;const pending=[];
   const answer=route=>route.fulfill({json:{id:'fixture',choices:[{message:{content:JSON.stringify({risk_score:10,verdict:'clear',reasoning:'REPORT-FOR-A'})}}]}});
   await page.route('**/api/gonka',route=>{if(hold)pending.push(route);else return answer(route)});
   await page.goto('http://127.0.0.1:5189/?batch='+a+'&serial=label-demo');
   await page.getByRole('heading',{name:'Product A',exact:true}).waitFor();
   await page.getByRole('button',{name:'Look up',exact:true}).click();
   assert.ok((await page.locator('body').innerText()).includes('#label-demo'),'lookup must preserve unchanged scanned serial');
   await page.getByLabel('How many packages need a label?').fill('2');
   await page.getByRole('button',{name:'Generate 2 QR codes',exact:true}).click();
   const first=await page.locator('.print-sheet .qr-card').allTextContents();
   await page.locator('details').last().locator('summary').click();
   await page.getByRole('button',{name:'Generate 2 QR codes',exact:true}).click();
   const second=await page.locator('.print-sheet .qr-card').allTextContents();
   assert.equal(new Set([...first,...second]).size,4,'regenerated label IDs must not restart at 1');
   console.log('PASS: serial preservation and repeated label generation');
   await page.getByRole('button',{name:'Run AI verification',exact:true}).click();
   for(let n=0;pending.length<2 && n<50;n++)await page.waitForTimeout(100);
   assert.equal(pending.length,2);
   await page.getByLabel('Batch object ID',{exact:true}).fill(b);
   await page.getByRole('button',{name:'Look up',exact:true}).click();
   await page.getByRole('heading',{name:'Product B',exact:true}).waitFor();
   assert.equal(await page.locator('.print-sheet').count(),0,'A labels must disappear on B');
   hold=false;await Promise.all(pending.map(answer));await page.waitForTimeout(300);
   assert.ok(!(await page.locator('body').innerText()).includes('REPORT-FOR-A'),'late A report must not appear on B');
   assert.equal(await page.getByRole('button',{name:'Run AI verification',exact:true}).isEnabled(),true);
   console.log('PASS: late AI result cannot attach to another batch');
   await page.getByLabel('Batch object ID',{exact:true}).fill(wrong);
   await page.getByRole('button',{name:'Look up',exact:true}).click();
   await page.getByText('No compatible batch found.',{exact:false}).waitFor();
   assert.equal(await page.getByRole('heading',{name:'Product B',exact:true}).count(),0);
   assert.deepEqual(errors,[]);
   console.log('PASS: incompatible object is rejected, no uncaught page errors');
   // PAYMENT-STATE-TEST
   await page.goto('http://127.0.0.1:5189/?unit='+wrong);
   await page.getByText('No compatible sale object was found.',{exact:false}).waitFor();
   assert.ok(!(await page.locator('body').innerText()).includes('already been paid for and burned'));
   await page.goto('http://127.0.0.1:5189/?unit='+'0x'+'5'.repeat(64));
   await page.getByText('Could not read this sale QR.',{exact:false}).waitFor();
   assert.ok(!(await page.locator('body').innerText()).includes('No compatible sale object was found.'));
   console.log('PASS: RPC failure and incompatible object do not claim redemption');
   // END-PAYMENT-STATE-TEST
 } finally {if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
