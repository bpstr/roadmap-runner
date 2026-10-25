// Synthetic service contract and local stages. No browser, service or provider.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const stage = process.argv[2];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync('dispatches.jsonl', JSON.stringify({ stage }) + '\n');
try {
  if (stage === 'configuration') {
    const fixture = read('fixture.json'), contract = read('service.json');
    assert.deepEqual(Object.keys(fixture).sort(), ['enabled', 'itemId', 'roles', 'timeoutMs']);
    assert.equal(typeof fixture.itemId, 'string', 'itemId must be a string');
    assert.equal(typeof fixture.enabled, 'boolean', 'enabled must be a boolean');
    assert.ok(Array.isArray(fixture.roles) && fixture.roles.includes('reader'), 'reader authorization is required');
    assert.ok(Number.isSafeInteger(fixture.timeoutMs) && fixture.timeoutMs > 0 && fixture.timeoutMs <= contract.maxTimeoutMs, 'fixture timeout exceeds service limit');
  } else if (stage === 'compile') {
    if (read('build.json').hang) { setInterval(() => {}, 1000); return; }
    // A prepared compiler validates the synthetic source inventory and shape.
    // This does not claim TypeScript or live-service compilation assurance.
    const source = read('source/control.json');
    assert.equal(typeof source.enforceAuthorization, 'boolean');
    console.log('prepared compilation passed');
  } else if (stage === 'module') {
    assert.equal(read('mapping.json').public, './source/control.json', 'ERR_MODULE_NOT_FOUND: public module mapping');
  } else if (stage === 'mount') {
    assert.equal(read('fixture.json').enabled, true, 'fixture must mount the control');
  } else if (stage === 'behavior') {
    assert.equal(read('source/control.json').enforceAuthorization, true, 'authorization control missing');
    assert.equal(read('fixture.json').itemId, 'example', 'exact content assertion');
    console.log('# tests 1\n# pass 1\n# fail 0\n# skipped 0');
  } else if (stage !== 'cleanup') throw new Error('Unknown prepared stage');
} catch (error) { console.error(`${stage}: ${error.message}`); process.exitCode = 1; }
