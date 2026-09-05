const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');

test('client and proxy requests have bounded abort signals',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
  const before=global.fetch, log=console.error, oldKey=process.env.GONKA_API_KEY;
  const durations=[];
  Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:ms=>{durations.push(ms);return AbortSignal.abort(new Error('fixture timeout'));}});
  global.fetch=async(_url,options)=>{assert.equal(options.signal.aborted,true);throw options.signal.reason;};
  console.error=()=>{};process.env.GONKA_API_KEY='test-placeholder';
  try {
    assert.equal((await ai.checkAnomaly(batch())).consensus,'unavailable');
    let status;
    await load('../api/gonka').default({method:'POST',body:{}},{status:n=>{status=n;return {json:()=>{}}}});
    assert.equal(status,502);assert.deepEqual(durations,[125000,125000,120000]);
  }finally{Object.defineProperty(AbortSignal,'timeout',descriptor);global.fetch=before;console.error=log;if(oldKey===undefined)delete process.env.GONKA_API_KEY;else process.env.GONKA_API_KEY=oldKey;}
});
