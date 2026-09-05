const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('no anomaly is an empty list, not a warning message', () => {
  assert.deepEqual(rules.analyzeCrossBatch([batch(), {...batch(), objectId: '0x2'}]), []);
  assert.deepEqual(rules.analyzeCrossBatch([batch()]), []);
});
test('offline AI with no cross-batch issues is unavailable, not flagged', async () => {
  const before=global.fetch, log=console.error; console.error=()=>{};
  global.fetch=async()=>{throw Error('offline')};
  try { assert.equal((await ai.checkCrossBatchAnomaly([batch(),{...batch(),objectId:'0x2'}])).consensus,'unavailable'); }
  finally {global.fetch=before;console.error=log;}
});
