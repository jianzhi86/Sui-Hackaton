const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('two independent clear results are required for clear', () => {
  assert.equal(ai.summarizeReport([], [verdict()]).consensus, 'needs_review');
  assert.equal(ai.summarizeReport([], [verdict(), verdict()]).consensus, 'needs_review');
  assert.equal(ai.summarizeReport([], [verdict(), verdict('B')]).consensus, 'clear');
});
test('rules override model clear and disagreement remains reviewable', () => {
  assert.equal(ai.summarizeReport(['ON HOLD'], [verdict(), verdict('B')]).consensus, 'flag');
  assert.equal(ai.summarizeReport([], [verdict(), verdict('B', 'flag')]).consensus, 'needs_review');
});
