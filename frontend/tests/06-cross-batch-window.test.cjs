const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('cross-batch windows find bursts despite old activity and duplicate batch codes', () => {
  const batches = [1,2,3].map(i => ({...batch(['distributor']), objectId: '0x'+i}));
  batches[0].checkpoints.unshift({...batches[0].checkpoints[0], timestampMs: -3 * 86400000});
  assert.ok(rules.analyzeCrossBatch(batches).some(s => s.includes('3 distinct batches')));
});
