import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechEndDetector, MicrophoneListener } from '../speech-end.mjs';

test('initial silence or a brief click never finishes a turn', () => {
  const d = new SpeechEndDetector();
  assert.equal(d.sample(0, 15000).complete, false);
  d.sample(.1, 16000);
  d.sample(0, 16100);
  assert.equal(d.sample(0, 60000).complete, false);
});

test('continued speech and short pauses postpone completion', () => {
  const d = new SpeechEndDetector();
  d.sample(.1, 0);
  assert.equal(d.sample(.1, 300).heard, true);
  assert.equal(d.sample(0, 3299).complete, false);
  d.sample(.1, 3299);
  assert.equal(d.sample(0, 6298).complete, false);
  assert.equal(d.sample(0, 6299).complete, true);
});

test('longer silence setting is respected', () => {
  const d = new SpeechEndDetector({ silenceMs: 8000 });
  d.sample(.1, 0); d.sample(.1, 300);
  assert.equal(d.sample(0, 3300).complete, false);
  assert.equal(d.sample(0, 8300).complete, true);
});

test('permission result arriving after cancellation releases the microphone', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldSecure = globalThis.isSecureContext;
  const oldContext = globalThis.AudioContext;
  let resolveStream;
  let stopped = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) } } });
  globalThis.isSecureContext = true;
  globalThis.AudioContext = class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } };
  try {
    const mic = new MicrophoneListener();
    const pending = mic.prepare(3000);
    await Promise.resolve();
    mic.close();
    resolveStream({ getTracks: () => [{ stop() { stopped++; } }] });
    await assert.rejects(pending, /Cancelled/);
    assert.equal(stopped, 1);
    assert.equal(mic.stream, null);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
    globalThis.isSecureContext = oldSecure;
    globalThis.AudioContext = oldContext;
  }
});

function microphoneEnvironment(run) {
  const saved = ['performance', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let time = 1000, serial = 0, stops = 0;
  const frames = new Map();
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => time } });
  globalThis.requestAnimationFrame = fn => { frames.set(++serial, fn); return serial; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const mic = new MicrophoneListener();
  const track = { readyState: 'live', stop() { stops++; }, enabled: false };
  mic.context = { state: 'running', close: () => Promise.resolve() };
  mic.stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  mic.silenceMs = 3000;
  mic.buffer = new Float32Array(8);
  const step = ms => { time += ms; const next = frames.entries().next().value; if (next) { frames.delete(next[0]); next[1](); } };
  try { run({ mic, frames, step, stops: () => stops }); }
  finally { mic.close(); for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  } }
}

test('microphone analysis exception releases the device and reports manual fallback', () => {
  microphoneEnvironment(({ mic, frames, step, stops }) => {
    let errors = 0, completed = 0;
    mic.analyser = { getFloatTimeDomainData() { throw new Error('Lost device'); } };
    mic.start({ onUpdate() {}, onError() { errors++; }, onComplete() { completed++; } });
    step(500);
    assert.equal(errors, 1);
    assert.equal(completed, 0);
    assert.equal(stops(), 1);
    assert.equal(frames.size, 0);
  });
});

test('byte analyser fallback works and cancellation during an update schedules no extra frame', () => {
  microphoneEnvironment(({ mic, frames, step }) => {
    let updates = 0;
    mic.analyser = { getByteTimeDomainData(buffer) { buffer.fill(128); } };
    mic.start({ onUpdate(result) { updates++; assert.equal(result.heard, false); mic.stop(); },
      onError() { assert.fail('Unexpected analysis error'); }, onComplete() { assert.fail('Silence is not speech'); } });
    step(500);
    assert.equal(updates, 1);
    assert.equal(frames.size, 0);
  });
});
