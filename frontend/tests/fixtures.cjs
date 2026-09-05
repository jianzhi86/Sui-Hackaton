const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function loader(overrides = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(__dirname, '../src', file);
    if (!path.extname(file)) file += fs.existsSync(file + '.ts') ? '.ts' : '.tsx';
    if (cache.has(file)) return cache.get(file);
    const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})');
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    }}).outputText;
    const mod = { exports: {} }; cache.set(file, mod.exports);
    new Function('require', 'exports', 'module', code)((id) => {
      if (id in overrides) return overrides[id];
      if (id.endsWith('/network') || id === './network') return { PACKAGE_ID: '0x456', TYPE_PACKAGE_ID: '0x123', TEMPERATURE_OFFSET_C: 200 };
      return id.startsWith('.') ? load(path.resolve(path.dirname(file), id)) : require(id);
    }, mod.exports, mod);
    return mod.exports;
  }
  return load;
}
const load = loader();
const rules = load('lib/chainAnalysis');
const ai = load('lib/gonka');
const reader = load('lib/suiRead');
function batch(roles = ['distributor', 'pharmacy']) {
  return { objectId: '0x1', batchCode: 'same-code', productName: 'Test', manufacturer: '0xmaker',
    createdAtMs: 1000, expiryMs: Date.now() + 86400000, isHeld: false, holdHistory: [],
    checkpoints: roles.map((role, i) => ({ role, location: 'Site ' + i, actor: '0xactor',
      timestampMs: 2000 + i * 1000, note: '', temperatureC: null })) };
}
const verdict = (model = 'A', flag = 'clear') => ({ model, verdict: flag, riskScore: 0, reasoning: 'Evidence', requestId: model });
const response = (type = '0x123::batch::Batch', fields = {}) => ({data:{objectId:'0x1',content:{dataType:'moveObject',type,fields}}});
const fields = { batch_code:'B',product_name:'P',checkpoints:[],hold_history:[],is_held:false,expiry_ms:'1800000000000' };
module.exports={test,assert,loader,load,rules,ai,reader,batch,verdict,response,fields};
