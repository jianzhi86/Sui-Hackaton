const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('expiry is included in deterministic findings', () => {
  assert.match(rules.analyzeChain({ ...batch(), expiryMs: 1 })[0], /expired/);
});
