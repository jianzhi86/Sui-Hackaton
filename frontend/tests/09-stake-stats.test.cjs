const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('stats includes stake added after registration', async () => {
  let query;
  const stats=loader({
    '@mysten/dapp-kit':{useSuiClient:()=>({})},
    '@tanstack/react-query':{useQuery:options=>{query=options.queryFn;return {}; }},
    '../lib/activeHolds':{fetchAllEvents:async(_c,type)=>type.endsWith('BatchCreated')?[{parsedJson:{stake_amount:'1000000000'}}]:type.endsWith('StakeAdded')?[{parsedJson:{amount:'2000000000'}}]:[]},
  });
  stats('components/StatsDashboard').StatsDashboard();
  assert.equal((await query()).totalStakedSui,3);
});
