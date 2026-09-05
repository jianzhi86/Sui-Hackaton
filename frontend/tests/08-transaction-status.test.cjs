const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('transaction failure and missing effects reject; confirmed success resolves', async () => {
  for (const status of ['failure', undefined, 'success']) {
    const hooks=loader({'@mysten/dapp-kit':{
      useSuiClient:()=>({executeTransactionBlock:async input=>{
        assert.equal(input.options.showEffects,true);
        return {digest:'test',effects:status?{status:{status,error:'MoveAbort'}}:undefined};
      }}), useSignAndExecuteTransaction:options=>options,
    }});
    const promise=hooks('lib/useSignAndExecute').useSignAndExecute().execute({bytes:'',signature:''});
    if(status==='success') assert.equal((await promise).digest,'test'); else await assert.rejects(promise);
  }
});
