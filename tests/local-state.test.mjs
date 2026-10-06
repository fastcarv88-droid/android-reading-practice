import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPracticeState, STORAGE_KEY, DEFAULT_SETTINGS } from '../local-state.mjs';
import { GroupPractice } from '../group-practice.mjs';
import { FakeClock } from './fake-clock.mjs';

const phrases = [
  { id: 'hello', text: '你好。', audio: 'audio/hello.wav' },
  { id: 'water', text: '我想喝水。', audio: 'audio/water.wav' },
];
const settings = { repeats: 2, silenceSeconds: 5 };

function fixture() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const store = new LocalPracticeState(() => storage);
  const audio = new EventTarget();
  audio.calls = 0;
  audio.play = () => { audio.calls++; audio.ended = false; return Promise.resolve(); };
  audio.pause = () => {};
  const sessions = [];
  const listener = { stop() {}, start: session => sessions.push(session),
    snapshot: () => ({ heard: true, onsetMs: 300, quietMs: 1000 }) };
  const practice = new GroupPractice({ audio, listener, phrases, clock: new FakeClock(), onState() {} });
  const ended = () => { audio.ended = true; audio.dispatchEvent(new Event('ended')); };
  return { values, storage, store, audio, sessions, practice, ended };
}

test('first use has default settings and no automatic progress', () => {
  const f = fixture();
  assert.deepEqual(f.store.read(phrases), { settings: { ...DEFAULT_SETTINGS }, progress: null, notice: '' });
});

test('playback progress and settings round-trip without playing on restore', () => {
  const f = fixture();
  f.practice.start(1);
  assert.equal(f.store.write(f.practice, settings), true);
  const restored = f.store.read(phrases);
  assert.deepEqual(restored.settings, settings);
  assert.equal(restored.progress.index, 1);
  assert.equal(restored.progress.phase, 'paused');
  assert.equal(restored.progress.resumePhase, 'playing');
  const reopened = fixture();
  reopened.practice.restore(restored.progress, restored.settings.repeats);
  assert.equal(reopened.practice.phase, 'paused');
  assert.equal(reopened.audio.calls, 0);
  assert.equal(reopened.sessions.length, 0);
  reopened.practice.resume();
  assert.equal(reopened.audio.src, 'audio/water.wav');
  assert.equal(reopened.audio.currentTime, 0);
});

test('paused listening preserves the remaining quiet period and repeat count', () => {
  const f = fixture();
  f.practice.start(1); f.ended(); f.practice.pause();
  f.store.write(f.practice, settings);
  const restored = f.store.read(phrases);
  assert.equal(restored.progress.completed, 1);
  assert.equal(restored.progress.resumePhase, 'listening');
  assert.deepEqual(restored.progress.snapshot, { heard: true, onsetMs: 300, quietMs: 1000 });
  const reopened = fixture();
  reopened.practice.restore(restored.progress, 2);
  assert.equal(reopened.sessions.length, 0);
  reopened.practice.resume();
  assert.equal(reopened.audio.calls, 0);
  assert.equal(reopened.sessions[0].initial.quietMs, 1000);
});

test('the audio-end transition never saves a previous round microphone snapshot', () => {
  const f = fixture();
  f.practice.onState = state => { if (state.phase === 'listening') f.store.write(f.practice, settings); };
  f.practice.start(); f.ended();
  const data = JSON.parse(f.values.get(STORAGE_KEY));
  assert.equal(data.progress.snapshot, undefined);
});

test('phrase order changes restore by ID instead of the old position', () => {
  const f = fixture();
  f.practice.start(1); f.store.write(f.practice, settings);
  const restored = f.store.read([...phrases].reverse());
  assert.equal(restored.progress.index, 0);
  assert.equal(restored.progress.phase, 'paused');
});

test('deleted current phrase resets to first phrase and stays paused', () => {
  const f = fixture();
  f.practice.start(1); f.store.write(f.practice, settings);
  const restored = f.store.read([phrases[0]]);
  assert.equal(restored.notice, 'changed');
  assert.equal(restored.progress.index, 0);
  assert.equal(restored.progress.completed, 0);
  assert.equal(restored.progress.phase, 'paused');
  assert.deepEqual(restored.settings, settings);
});

test('malformed JSON and an unknown version do not break startup', () => {
  for (const raw of ['{bad', 'null', JSON.stringify({ version: 77, settings })]) {
    const f = fixture(); f.values.set(STORAGE_KEY, raw);
    const restored = f.store.read(phrases);
    assert.equal(restored.notice, 'invalid');
    assert.equal(restored.progress, null);
    assert.deepEqual(restored.settings, DEFAULT_SETTINGS);
  }
});

test('unavailable browser storage and quota failure are recoverable', () => {
  const unavailable = new LocalPracticeState(() => { throw new Error('Blocked'); });
  assert.equal(unavailable.read(phrases).notice, 'unavailable');
  const f = fixture();
  f.storage.setItem = () => { throw new Error('Quota'); };
  f.practice.start();
  assert.equal(f.store.write(f.practice, settings), false);
  assert.equal(f.practice.phase, 'playing');
});

test('invalid counts and phases cannot restore an impossible repeat', () => {
  for (const patch of [{ completed: 99 }, { completed: -1 }, { completed: 2.5 },
    { completed: 2, phase: 'playing' }, { completed: 0, phase: 'listening' }, { phase: 'unknown' }]) {
    const f = fixture(); f.practice.start(1); f.store.write(f.practice, settings);
    const data = JSON.parse(f.values.get(STORAGE_KEY));
    Object.assign(data.progress, patch);
    f.values.set(STORAGE_KEY, JSON.stringify(data));
    const restored = f.store.read(phrases);
    assert.equal(restored.notice, 'invalid');
    assert.equal(restored.progress.phase, 'paused');
    assert.equal(restored.progress.completed, 0);
    assert.equal(restored.progress.index, 1);
  }
});

test('invalid setting values fall back to supported values', () => {
  const f = fixture(); f.practice.start(); f.store.write(f.practice, settings);
  const data = JSON.parse(f.values.get(STORAGE_KEY));
  data.settings = { repeats: 100, silenceSeconds: -20 };
  f.values.set(STORAGE_KEY, JSON.stringify(data));
  assert.deepEqual(f.store.read(phrases).settings, DEFAULT_SETTINGS);
});

test('extra demonstration remains extra across reload', () => {
  const f = fixture();
  f.practice.start(); f.ended(); f.practice.replay();
  f.store.write(f.practice, settings);
  const restored = f.store.read(phrases);
  const reopened = fixture();
  reopened.practice.restore(restored.progress, 2); reopened.practice.resume(); reopened.ended();
  assert.equal(reopened.practice.kind, 'extra');
  assert.equal(reopened.practice.completed, 1);
});

test('finished groups remain stopped when reopened', () => {
  const f = fixture(); f.practice.start(1); f.practice.next(); f.store.write(f.practice, settings);
  const restored = f.store.read(phrases);
  const reopened = fixture(); reopened.practice.restore(restored.progress, 2);
  assert.equal(reopened.practice.phase, 'complete');
  assert.equal(reopened.audio.calls, 0);
});

test('reset replaces prior progress while preserving settings', () => {
  const f = fixture();
  f.practice.start(1); f.ended(); f.practice.pause(); f.store.write(f.practice, settings);
  f.practice.reset(); f.store.write(f.practice, settings);
  const restored = f.store.read(phrases);
  assert.equal(restored.progress.index, 0);
  assert.equal(restored.progress.completed, 0);
  assert.equal(restored.progress.phase, 'idle');
  assert.deepEqual(restored.settings, settings);
});
