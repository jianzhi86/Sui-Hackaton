const {test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields}=require('./fixtures.cjs');
test('invalid model schemas never count as valid verdicts', () => {
  for (const raw of ['{}', 'null', '[]', '{"risk_score":0,"verdict":"maybe","reasoning":"x"}',
    '{"risk_score":"0","verdict":"clear","reasoning":"x"}', '{"risk_score":101,"verdict":"clear","reasoning":"x"}']) {
    assert.equal(ai.parseModelJson('A', 'id', raw), null);
  }
});
test('valid fenced model output is preserved', () => {
  const raw = '<think>reason</think>\n```json\n{"risk_score":12,"verdict":"clear","reasoning":"Valid evidence"}\n```';
  assert.equal(ai.parseModelJson('A', 'id', raw).riskScore, 12);
});
test('empty JSON end-to-end does not produce zero-risk clear', async () => {
  const before=global.fetch;
  global.fetch=async(_url,options)=>{
    return {ok:true,json:async()=>({choices:[{message:{content:'{}'}}]})};
  };
  try { const r=await ai.checkAnomaly(batch()); assert.equal(r.consensus,'unavailable');assert.equal(r.combinedRiskScore,null); }
  finally {global.fetch=before;}
});
