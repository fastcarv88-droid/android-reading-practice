import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GroupPractice } from '../group-practice.mjs';
import { SpeechEndDetector } from '../speech-end.mjs';
import { FakeClock } from './fake-clock.mjs';

function fixture({ repeats = 2, count = 2 } = {}) {
  const audio = new EventTarget();
  audio.calls = 0;
  audio.ended = false;
  audio.play = () => { audio.calls++; audio.ended = false; return Promise.resolve(); };
  audio.pause = () => {};
  const sessions = [];
  const listener = { start(callbacks) { sessions.push(callbacks); }, stop() {},
    snapshot() { return { heard: true, quietMs: 1000 }; } };
  const states = [];
  const phrases = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, text: `句${i}`, audio: `audio/p${i}.wav` }));
  const clock = new FakeClock();
  const practice = new GroupPractice({ audio, listener, phrases, repeats, clock, onState: s => states.push(s) });
  const ended = () => { audio.ended = true; audio.dispatchEvent(new Event('ended')); };
  const finish = () => sessions.at(-1).onComplete();
  return { practice, audio, listener, sessions, states, ended, finish, clock };
}

test('100-item library pauses at the next group and resumes that phrase without autoplay', () => {
  const f = fixture({ count: 100, repeats: 1 });
  f.practice.start(9);
  f.ended(); f.finish();
  assert.equal(f.practice.index, 10);
  assert.equal(f.practice.phase, 'paused');
  assert.equal(f.practice.pauseReason, 'group-break');
  assert.equal(f.audio.calls, 1);
  f.practice.resume();
  assert.equal(f.practice.index, 10);
  assert.equal(f.practice.phase, 'playing');
  assert.equal(f.audio.calls, 2);
  f.practice.pause();
  f.practice.start(99);
  f.ended(); f.finish();
  assert.equal(f.practice.phase, 'complete');
});

test('repeating the same sentence retains buffered audio; changing sentence reloads it', () => {
  const f = fixture();
  let source, assignments = 0;
  Object.defineProperty(f.audio, 'src', { get: () => source, set(value) { source = value; assignments++; } });
  f.practice.start(); f.ended(); f.finish();
  assert.equal(assignments, 1);
  f.practice.replay();
  assert.equal(assignments, 1);
  f.practice.next();
  assert.equal(assignments, 2);
});

test('whole group: two repeats per sentence, listen after audio, stop at the end', () => {
  const f = fixture();
  f.practice.start();
  assert.equal(f.sessions.length, 0);
  for (let index = 0; index < 2; index++) {
    for (let round = 1; round <= 2; round++) {
      assert.equal(f.practice.phase, 'playing');
      assert.equal(f.practice.index, index);
      f.ended();
      assert.equal(f.practice.phase, 'listening');
      assert.equal(f.practice.completed, round);
      f.finish();
    }
  }
  assert.equal(f.practice.phase, 'complete');
  assert.equal(f.audio.calls, 4);
  f.practice.finishSpeaking(); f.practice.next(); f.practice.replay(); f.ended();
  assert.equal(f.audio.calls, 4);
});

test('one and three repeats produce the expected number of demonstrations', () => {
  for (const repeats of [1, 3]) {
    const f = fixture({ repeats });
    f.practice.start();
    for (let i = 0; i < repeats * 2; i++) { f.ended(); f.finish(); }
    assert.equal(f.audio.calls, repeats * 2);
    assert.equal(f.practice.phase, 'complete');
  }
});

test('pause during audio resumes the same round from its beginning', () => {
  const f = fixture();
  f.practice.start(); f.ended(); f.finish();
  f.audio.currentTime = .7;
  f.practice.pause();
  assert.equal(f.practice.phase, 'paused');
  assert.equal(f.states.at(-1).round, 2);
  f.ended();
  assert.equal(f.practice.completed, 1);
  f.practice.resume();
  assert.equal(f.audio.currentTime, 0);
  assert.equal(f.practice.index, 0);
  assert.equal(f.practice.completed, 1);
  f.ended();
  assert.equal(f.practice.completed, 2);
});

test('pause while listening freezes progress and ignores stale completion', () => {
  const f = fixture();
  f.practice.start(); f.ended();
  const old = f.sessions[0];
  f.practice.pause(); old.onComplete();
  assert.equal(f.practice.phase, 'paused');
  assert.equal(f.audio.calls, 1);
  f.practice.resume();
  assert.equal(f.practice.phase, 'listening');
  assert.deepEqual(f.sessions[1].initial, { heard: true, quietMs: 1000 });
  old.onComplete();
  assert.equal(f.practice.phase, 'listening');
  f.finish();
  assert.equal(f.audio.calls, 2);
});

test('remaining silence excludes paused time; new sound resets it', () => {
  const detector = new SpeechEndDetector();
  detector.sample(.1, 0); detector.sample(.1, 300);
  const initial = detector.snapshot(1300);
  const resumed = new SpeechEndDetector({ initial, time: 60000 });
  assert.equal(resumed.sample(0, 61999).complete, false);
  assert.equal(resumed.sample(0, 62000).complete, true);
  const resumedWithSound = new SpeechEndDetector({ initial, time: 60000 });
  resumedWithSound.sample(.1, 61000);
  assert.equal(resumedWithSound.sample(0, 63999).complete, false);
  assert.equal(resumedWithSound.sample(0, 64000).complete, true);
});

test('extra demonstration during listening does not consume a preset repeat', () => {
  const f = fixture();
  f.practice.start(); f.ended();
  const old = f.sessions[0];
  f.practice.replay();
  assert.equal(f.practice.kind, 'extra');
  assert.equal(f.practice.completed, 1);
  f.ended(); old.onComplete();
  assert.equal(f.practice.phase, 'listening');
  assert.equal(f.practice.completed, 1);
  f.finish();
  assert.equal(f.practice.kind, 'scheduled');
  assert.equal(f.practice.completed, 1);
  assert.equal(f.audio.calls, 3);
  f.ended(); f.finish();
  assert.equal(f.practice.index, 1);
});

test('extra demonstration interrupted during scheduled playback keeps that round pending', () => {
  const f = fixture();
  f.practice.start(); f.practice.replay(); f.ended();
  assert.equal(f.practice.completed, 0);
  f.finish();
  assert.equal(f.practice.kind, 'scheduled');
  assert.equal(f.practice.completed, 0);
  f.ended();
  assert.equal(f.practice.completed, 1);
});

test('pause and resume an extra demonstration does not convert it to a scheduled one', () => {
  const f = fixture();
  f.practice.start(); f.ended(); f.practice.replay(); f.practice.pause(); f.practice.resume();
  assert.equal(f.practice.kind, 'extra');
  f.ended();
  assert.equal(f.practice.completed, 1);
});

test('next cancels old listening and starts new sentence at round one', () => {
  const f = fixture();
  f.practice.start(); f.ended();
  const old = f.sessions[0];
  f.practice.next();
  assert.equal(f.practice.index, 1);
  assert.equal(f.practice.completed, 0);
  assert.equal(f.audio.src, 'audio/p1.wav');
  old.onComplete(); old.onUpdate({ heard: true });
  assert.equal(f.practice.phase, 'playing');
  assert.equal(f.practice.completed, 0);
});

test('next on the last sentence ends group without another playback', () => {
  const f = fixture({ count: 1 });
  f.practice.start(); f.practice.pause(); f.practice.next();
  assert.equal(f.practice.phase, 'complete');
  assert.equal(f.audio.calls, 1);
});

test('duplicate start and completion events do not count twice', () => {
  const f = fixture();
  f.practice.start(); f.practice.start();
  assert.equal(f.audio.calls, 1);
  f.ended(); f.ended();
  assert.equal(f.sessions.length, 1);
  assert.equal(f.practice.completed, 1);
  const old = f.sessions[0];
  old.onComplete(); old.onComplete();
  assert.equal(f.audio.calls, 2);
});

test('microphone failure leaves current turn waiting for manual confirmation', () => {
  const f = fixture();
  f.practice.start(); f.ended(); f.sessions[0].onError();
  assert.equal(f.states.at(-1).manual, true);
  assert.equal(f.practice.phase, 'listening');
  assert.equal(f.audio.calls, 1);
  f.practice.finishSpeaking();
  assert.equal(f.audio.calls, 2);
});

test('audio rejection preserves progress and permits retry', async () => {
  const f = fixture();
  f.audio.play = () => Promise.reject(new Error('Blocked'));
  f.practice.start();
  await Promise.resolve();
  assert.equal(f.practice.phase, 'error');
  assert.equal(f.practice.completed, 0);
  f.audio.play = () => Promise.resolve();
  f.practice.resume(); f.ended();
  assert.equal(f.practice.completed, 1);
});

test('old play rejection cannot break the new sentence', async () => {
  const f = fixture();
  let reject;
  f.audio.play = () => new Promise((resolve, fail) => { reject = fail; });
  f.practice.start();
  const oldReject = reject;
  f.audio.play = () => Promise.resolve();
  f.practice.next();
  oldReject(new Error('Old request failed'));
  await Promise.resolve();
  assert.equal(f.practice.index, 1);
  assert.equal(f.practice.phase, 'playing');
});

test('completed group restarts explicitly at the first sentence', () => {
  const f = fixture({ count: 1, repeats: 1 });
  f.practice.start(); f.ended(); f.finish();
  assert.equal(f.practice.phase, 'complete');
  f.practice.start();
  assert.equal(f.practice.phase, 'playing');
  assert.equal(f.practice.index, 0);
  assert.equal(f.practice.completed, 0);
});

test('the actual 100-item list plays in order with explicit continuation at group breaks', () => {
  const f = fixture();
  const phrases = JSON.parse(readFileSync(new URL('../content/phrases.json', import.meta.url), 'utf8'));
  f.practice.phrases = phrases;
  f.practice.start();
  const played = [];
  for (const phrase of phrases) {
    if (f.practice.phase === 'paused') {
      assert.equal(f.practice.pauseReason, 'group-break');
      f.practice.resume();
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      played.push(f.audio.src);
      assert.equal(f.audio.src, phrase.audio);
      f.ended(); f.finish();
    }
  }
  assert.equal(played.length, 200);
  assert.equal(f.practice.phase, 'complete');
});

test('unresponsive playback times out without consuming a round or skipping a sentence', () => {
  const f = fixture();
  f.audio.play = () => new Promise(() => {});
  f.practice.start();
  f.clock.advance(20000);
  assert.equal(f.practice.phase, 'error');
  assert.equal(f.practice.problem, 'timeout');
  assert.equal(f.practice.index, 0);
  assert.equal(f.practice.completed, 0);
  assert.equal(f.sessions.length, 0);
  assert.equal(f.clock.tasks.size, 0);
});

test('only playback progress renews the watchdog; repeated stall events cannot mask failure', () => {
  const f = fixture(); f.practice.start();
  f.clock.advance(15000);
  f.audio.dispatchEvent(new Event('stalled'));
  f.audio.dispatchEvent(new Event('timeupdate'));
  f.clock.advance(5000);
  assert.equal(f.practice.phase, 'error');
  f.practice.resume();
  f.clock.advance(15000);
  f.audio.currentTime = .5;
  f.audio.dispatchEvent(new Event('timeupdate'));
  f.clock.advance(10000);
  assert.equal(f.practice.phase, 'playing');
  assert.equal(f.clock.tasks.size, 1);
});

test('paused and listening phases have no playback timeout', () => {
  const f = fixture(); f.practice.start(); f.practice.pause();
  assert.equal(f.clock.tasks.size, 0);
  f.clock.advance(60000);
  assert.equal(f.practice.phase, 'paused');
  f.practice.resume(); f.ended();
  assert.equal(f.clock.tasks.size, 0);
  f.clock.advance(60000);
  assert.equal(f.practice.phase, 'listening');
});

test('stale watchdog and media error cannot fail a new sentence', () => {
  const f = fixture(); f.practice.start();
  const oldTimer = [...f.clock.tasks.values()][0].fn;
  f.practice.next();
  oldTimer();
  f.audio.error = null;
  f.audio.dispatchEvent(new Event('error'));
  assert.equal(f.practice.phase, 'playing');
  assert.equal(f.practice.index, 1);
});

test('autoplay rejection and media decoding failure preserve progress for retry', async () => {
  const f = fixture();
  f.audio.play = () => Promise.reject(Object.assign(new Error('Blocked'), { name: 'NotAllowedError' }));
  f.practice.start(); await Promise.resolve();
  assert.equal(f.practice.problem, 'blocked');
  f.audio.play = () => Promise.resolve();
  f.practice.resume();
  f.audio.error = { code: 3 };
  f.audio.dispatchEvent(new Event('error'));
  assert.equal(f.practice.problem, 'audio');
  assert.equal(f.practice.completed, 0);
  assert.equal(f.clock.tasks.size, 0);
});
