const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('normal custody remains supported',()=>assert.deepEqual(rules.analyzeChain(batch()),[]));
