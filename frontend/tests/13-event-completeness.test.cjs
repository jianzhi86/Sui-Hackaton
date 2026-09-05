const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('event truncation is explicit instead of returning incomplete data', async () => {
  const {fetchAllEvents}=load('lib/activeHolds');
  await assert.rejects(fetchAllEvents({queryEvents:async()=>({data:[],hasNextPage:true,nextCursor:'next'})},'Event'),/complete result/);
  assert.deepEqual(await fetchAllEvents({queryEvents:async()=>({data:[1],hasNextPage:false})},'Event'),[1]);
});
test('missing cursor is not treated as complete history',async()=>{await assert.rejects(load('lib/activeHolds').fetchAllEvents({queryEvents:async()=>({data:[],hasNextPage:true})},'Event'),/incomplete/);});
