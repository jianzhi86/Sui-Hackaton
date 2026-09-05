const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('normal custody uses implicit manufacture and reversed custody is flagged', () => {
  assert.deepEqual(rules.analyzeChain(batch()), []);
  assert.equal(rules.analyzeChain(batch(['pharmacy', 'distributor'])).length, 1);
  assert.equal(rules.analyzeChain(batch(['pharmacy'])).length, 1);
});
