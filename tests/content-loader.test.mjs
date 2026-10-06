import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePhrases, loadPhrases, ContentError } from '../content-loader.mjs';
import { FakeClock } from './fake-clock.mjs';

const phrase = { id: 'water', text: '我想喝水。', audio: 'audio/water.wav' };

test('real ten-phrase manifest passes structural and relative-path checks', () => {
  const data = JSON.parse(readFileSync(new URL('../content/phrases.json', import.meta.url), 'utf8'));
  assert.equal(validatePhrases(data).length, 10);
});

test('wrong shape, empty list, missing or non-string fields are rejected', () => {
  for (const data of [null, {}, [], [null], [{ ...phrase, id: 1 }], [{ ...phrase, text: ' ' }], [{ ...phrase, audio: false }]]) {
    assert.throws(() => validatePhrases(data), ContentError);
  }
});

test('duplicate IDs are rejected before practice can start', () => {
  assert.throws(() => validatePhrases([phrase, { ...phrase }]), error => error.code === 'duplicate');
});

test('absolute paths, external audio and paths outside the project are rejected', () => {
  for (const audio of ['/audio/water.wav', 'https://elsewhere.invalid/water.wav', '../water.wav',
    'audio/../../water.wav', 'audio\\water.wav', 'audio/', 'audio/water.wav#clip']) {
    assert.throws(() => validatePhrases([{ ...phrase, audio }]), error => error.code === 'path');
  }
  assert.equal(validatePhrases([{ ...phrase, audio: './audio/water.wav?v=2' }])[0].id, 'water');
});

test('network failure, HTTP failure and malformed JSON surface errors', async () => {
  for (const fetcher of [() => Promise.reject(new Error('Offline')),
    async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw new SyntaxError('Bad JSON'); } })]) {
    const clock = new FakeClock();
    await assert.rejects(loadPhrases({ fetcher, clock }));
    assert.equal(clock.tasks.size, 0);
  }
});

test('an unresponsive fetch times out and is aborted rather than waiting forever', async () => {
  const clock = new FakeClock();
  let signal;
  const promise = loadPhrases({ clock, fetcher: (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  const check = assert.rejects(promise, error => error.code === 'timeout');
  await Promise.resolve();
  clock.advance(15000);
  await check;
  assert.equal(signal.aborted, true);
  assert.equal(clock.tasks.size, 0);
});

test('a stalled response body also times out and late data cannot win', async () => {
  const clock = new FakeClock();
  let resolveBody;
  const promise = loadPhrases({ clock, fetcher: async () => ({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) }) });
  const check = assert.rejects(promise, error => error.code === 'timeout');
  await new Promise(resolve => setImmediate(resolve));
  clock.advance(15000);
  await check;
  resolveBody([phrase]);
  await Promise.resolve();
  assert.equal(clock.tasks.size, 0);
});
