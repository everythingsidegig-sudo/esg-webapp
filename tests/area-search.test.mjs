import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../src/lib/area-search.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(fetch) {
  const exports = {};
  runInNewContext(code, { exports, fetch, AbortSignal, URL, URLSearchParams, process: { env: {} } });
  return exports;
}
const feature = (properties, coordinates = [-122.0238, 37.3764]) => ({ properties, geometry: { coordinates } });
const neighborhood = feature({ name: 'Downtown', type: 'district', city: 'Sunnyvale', state: 'California', country: 'United States' });
test('neighborhood names are retained with city and state', () => {
  const [match] = load().parseAreaMatches({ features: [neighborhood] });
  assert.equal(match.label, 'Downtown, Sunnyvale, California, United States');
  assert.equal(match.areaLabel, match.label);
  assert.equal(match.lat, 37.38);
  assert.equal(match.lng, -122.02);
});
test('address suggestions include the street while general labels exclude house numbers', () => {
  const [match] = load().parseAreaMatches({ features: [feature({ type: 'house', housenumber: '123', street: 'Main Street', district: 'Downtown', city: 'Sunnyvale', state: 'California' })] });
  assert.equal(match.label, '123 Main Street, Downtown, Sunnyvale, California');
  assert.equal(match.areaLabel, 'Downtown, Sunnyvale, California');
});
test('rejects malformed results and deduplicates matching neighborhoods', () => {
  assert.equal(load().parseAreaMatches(null).length, 0);
  const matches = load().parseAreaMatches({ features: [null, feature({}, [999, 200]), neighborhood, neighborhood] });
  assert.equal(matches.length, 1);
});
test('search handles Canadian areas and safely encodes user input', async () => {
  const api = load(async (url) => {
    assert.equal(url.searchParams.get('q'), 'Oliver, Edmonton');
    return { ok: true, json: async () => ({ features: [feature({ name: 'Oliver', type: 'district', city: 'Edmonton', state: 'Alberta', country: 'Canada' }, [-113.52, 53.54])] }) };
  });
  assert.equal((await api.searchAreas('Oliver, Edmonton', new AbortController().signal))[0].label, 'Oliver, Edmonton, Alberta, Canada');
});
test('short inputs do not fetch; failed and aborted searches do not return invented matches', async () => {
  const api = load(async () => { throw new Error('unavailable'); });
  assert.equal((await api.searchAreas('ab', new AbortController().signal)).length, 0);
  await assert.rejects(api.searchAreas('Sunnyvale', new AbortController().signal));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(load(async (_url, options) => { assert.equal(options.signal.aborted, true); throw new Error('aborted'); }).searchAreas('Sunnyvale', controller.signal));
});
