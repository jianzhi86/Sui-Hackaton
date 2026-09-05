const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('object parser rejects wrong types, packages and legacy expiry', () => {
  assert.equal(reader.parseBatchObject(response('0x2::coin::Coin<0x2::sui::SUI>', fields)), null);
  assert.equal(reader.parseBatchObject(response('0x456::batch::Batch', fields)), null);
  assert.equal(reader.parseBatchObject(response(undefined, {...fields, expiry_ms:undefined})), null);
  assert.ok(reader.parseBatchObject(response(undefined,fields)));
});
test('unit parser rejects unrelated and malformed objects', () => {
  assert.equal(reader.parseUnitObject(response()),null);
  assert.equal(reader.parseUnitObject(response('0x123::batch::Unit',{})),null);
});
