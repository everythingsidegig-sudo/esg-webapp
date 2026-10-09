import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../src/lib/zip-location.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const fixture = { places: [{ 'place name': 'Sunnyvale', 'state abbreviation': 'CA', latitude: '37.3764', longitude: '-122.0238' }] };
function load(fetch) {
  const exports = {};
  runInNewContext(code, { exports, fetch, AbortSignal });
  return exports;
}
test('accepts ZIP and ZIP+4, keeps leading zeroes, rejects partial ZIP and city names', () => {
  const { usZipCode } = load();
  assert.equal(usZipCode(' 02108 '), '02108');
  assert.equal(usZipCode('94086-1234'), '94086');
  for (const value of ['9408', '940860', 'Sunnyvale', '', '94086-12']) assert.equal(usZipCode(value), null);
});
test('resolves city/state label and approximate coordinates', () => {
  const area = load().parseZipLocation(fixture, '94086');
  assert.equal(area.label, 'Sunnyvale, CA 94086');
  assert.equal(area.lat, 37.38);
  assert.equal(area.lng, -122.02);
});
test('rejects missing or invalid coordinates instead of mapping to zero', () => {
  for (const data of [null, {}, { places: [] }, { places: [{ ...fixture.places[0], latitude: '' }] }, { places: [{ ...fixture.places[0], longitude: '999' }] }]) {
    assert.throws(() => load().parseZipLocation(data, '94086'));
  }
});
test('lookup uses normalized ZIP and propagates failures', async () => {
  const api = load(async (url) => {
    assert.equal(url, 'https://api.zippopotam.us/us/94086');
    return { ok: true, json: async () => fixture };
  });
  assert.equal((await api.lookupZipCode('94086-1234', new AbortController().signal)).label, 'Sunnyvale, CA 94086');
  await assert.rejects(load(async () => ({ ok: false })).lookupZipCode('00000', new AbortController().signal));
});
test('lookup passes cancellation to fetch for stale results', async () => {
  const controller = new AbortController();
  controller.abort();
  const api = load(async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new Error('aborted');
  });
  await assert.rejects(api.lookupZipCode('94086', controller.signal));
});
