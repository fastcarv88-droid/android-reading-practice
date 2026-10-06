import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GroupPractice } from '../group-practice.mjs';
import { LocalPracticeState, STORAGE_KEY } from '../local-state.mjs';
import { loadPhrases, ContentError } from '../content-loader.mjs';
import { FakeClock } from './fake-clock.mjs';
import { PageLifecycle } from '../page-lifecycle.mjs';

// Exercise the actual page controller with DOM/audio doubles, not a real browser.
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '');
const phrases = [
  { id: 'hello', text: '你好。', audio: 'audio/hello.wav' },
  { id: 'water', text: '我想喝水。', audio: 'audio/water.wav' },
];
const flush = () => new Promise(resolve => setImmediate(resolve));

function storage(initial) {
  const values = new Map(initial ? [[STORAGE_KEY, JSON.stringify(initial)]] : []);
  return { values, writes: 0, getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { this.writes++; values.set(key, value); } };
}

async function page(saved, { fetcher, content = phrases, deferMic = false, hidden = false } = {}) {
  const clock = new FakeClock();
  const microphoneReleases = [];
  class Element extends EventTarget {
    constructor() { super(); this.textContent = ''; this.value = ''; this.disabled = false; this.selectedIndex = 0; }
    replaceChildren(...options) { this.options = options; this.selectedIndex = 0; }
    click() { assert.equal(this.disabled, false); this.dispatchEvent(new Event('click')); }
  }
  const elements = new Map();
  const document = new EventTarget();
  document.hidden = hidden;
  const window = new EventTarget();
  document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.getElementById('repeats-select').value = '2';
  document.getElementById('silence-select').value = '3';
  let audio, microphone;
  class Audio extends EventTarget {
    constructor() { super(); audio = this; this.plays = 0; this.ended = false; this.paused = true; }
    play() { this.plays++; this.ended = false; this.paused = false; return Promise.resolve(); }
    pause() { const changed = !this.paused; this.paused = true; if (changed) this.dispatchEvent(new Event('pause')); }
    end() { this.ended = true; this.pause(); this.dispatchEvent(new Event('ended')); }
  }
  class MicrophoneListener {
    constructor({ onInterruption = () => {} } = {}) {
      microphone = this; this.ready = false; this.prepares = 0; this.sessions = [];
      this.onInterruption = onInterruption; this.epoch = 0;
    }
    async prepare(silenceMs) {
      this.close();
      const epoch = this.epoch;
      this.prepares++; this.silenceMs = silenceMs;
      if (deferMic) await new Promise(resolve => { microphoneReleases.push(resolve); });
      if (epoch !== this.epoch) throw new Error('Cancelled');
      this.ready = true;
    }
    start(callbacks) {
      this.sessions.push(callbacks);
      this.currentSnapshot = callbacks.initial || { heard: false, onsetMs: null, quietMs: null };
    }
    snapshot() { return this.currentSnapshot; }
    stop() {}
    close() { this.epoch++; this.ready = false; this.currentSnapshot = undefined; }
  }
  class PageStorage extends LocalPracticeState { constructor() { super(() => saved); } }
  class PagePractice extends GroupPractice { constructor(args) { super({ ...args, clock }); } }
  await vm.runInNewContext(source, {
    document, window, Audio, MicrophoneListener, GroupPractice: PagePractice,
    performance: { now: () => clock.now }, loadPhrases, ContentError, PageLifecycle,
    LocalPracticeState: PageStorage,
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    fetch: fetcher || (async path => { assert.equal(path, 'content/phrases.json'); return { ok: true, json: async () => content }; }),
  });
  return { ui: Object.fromEntries(elements), audio, microphone, clock, document, window,
    releaseMicrophone: (index = microphoneReleases.length - 1) => microphoneReleases[index]?.() };
}

test('page restores settings and current phrase paused, without requesting microphone', async () => {
  const saved = storage({ version: 1, settings: { repeats: 3, silenceSeconds: 8 },
    progress: { phraseId: 'water', phase: 'playing', completed: 1, kind: 'scheduled' } });
  const f = await page(saved);
  assert.equal(f.ui.phrase.textContent, '我想喝水。');
  assert.equal(f.ui.start.textContent, '继续');
  assert.equal(f.ui['repeats-select'].value, '3');
  assert.equal(f.ui['silence-select'].value, '8');
  assert.equal(f.audio.plays, 0);
  assert.equal(f.microphone.prepares, 0);
  f.ui.start.click(); await flush();
  assert.equal(f.microphone.silenceMs, 8000);
  assert.equal(f.audio.src, 'audio/water.wav');
  assert.match(f.ui.progress.textContent, /示范 2 \/ 3 遍/);
  f.ui.pause.click();
  const reopened = await page(saved);
  assert.equal(reopened.ui.start.textContent, '继续');
  assert.equal(reopened.audio.plays, 0);
  assert.equal(reopened.microphone.prepares, 0);
});

test('listening progress restores only after Continue and retains its silence snapshot', async () => {
  const saved = storage();
  const f = await page(saved);
  f.ui.start.click(); await flush(); f.audio.end();
  f.microphone.currentSnapshot = { heard: true, onsetMs: 300, quietMs: 1200 };
  f.microphone.sessions[0].onUpdate({ heard: true });
  f.ui.pause.click();
  const reopened = await page(saved);
  assert.equal(reopened.audio.plays, 0);
  assert.equal(reopened.microphone.sessions.length, 0);
  reopened.ui.start.click(); await flush();
  assert.equal(reopened.audio.plays, 0);
  assert.equal(reopened.microphone.sessions[0].initial.quietMs, 1200);
  assert.equal(reopened.ui.finished.hidden, false);
  reopened.ui.finished.click();
  assert.equal(reopened.audio.plays, 1);
});

test('reset stops current practice, clears progress and retains family settings', async () => {
  const saved = storage(); const f = await page(saved);
  f.ui['repeats-select'].value = '3';
  f.ui['repeats-select'].dispatchEvent(new Event('change'));
  f.ui['silence-select'].value = '5';
  f.ui['silence-select'].dispatchEvent(new Event('change'));
  f.ui.start.click(); await flush(); f.audio.end(); f.ui.finished.click();
  f.ui.reset.click();
  assert.equal(f.ui.start.textContent, '开始练习');
  assert.equal(f.ui.phrase.textContent, '你好。');
  assert.equal(f.microphone.ready, false);
  const data = JSON.parse(saved.values.get(STORAGE_KEY));
  assert.equal(data.progress.completed, 0);
  assert.equal(data.progress.phase, 'idle');
  assert.deepEqual(data.settings, { repeats: 3, silenceSeconds: 5 });
  const reopened = await page(saved);
  assert.equal(reopened.ui['silence-select'].value, '5');
  assert.equal(reopened.audio.plays, 0);
});

test('storage errors show a visible warning while the page remains usable', async () => {
  const broken = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } };
  const f = await page(broken);
  assert.match(f.ui['save-status'].textContent, /无法保存/);
  assert.equal(f.ui.start.disabled, false);
  f.ui.start.click(); await flush();
  assert.equal(f.audio.plays, 1);
});

test('completion stays stopped across reopen; restart begins at first sentence', async () => {
  const saved = storage({ version: 1, settings: { repeats: 1, silenceSeconds: 3 },
    progress: { phraseId: 'hello', phase: 'idle', completed: 0, kind: 'scheduled' } });
  const f = await page(saved);
  f.ui.start.click(); await flush();
  for (const phrase of phrases) {
    assert.equal(f.audio.src, phrase.audio);
    f.audio.end(); f.ui.finished.click();
  }
  assert.match(f.ui.status.textContent, /这一组结束/);
  const reopened = await page(saved);
  assert.equal(reopened.audio.plays, 0);
  assert.equal(reopened.ui.start.textContent, '重新开始这组');
  reopened.ui.start.click(); await flush();
  assert.equal(reopened.audio.src, 'audio/hello.wav');
});

test('microphone samples do not continuously write browser storage', async () => {
  const saved = storage(); const f = await page(saved);
  f.ui.start.click(); await flush(); f.audio.end();
  f.microphone.currentSnapshot = { heard: true, onsetMs: 300, quietMs: 0 };
  f.microphone.sessions[0].onUpdate({ heard: true, quietMs: 0 });
  const writes = saved.writes;
  for (let i = 1; i <= 100; i++) f.microphone.sessions[0].onUpdate({ heard: true, quietMs: i });
  assert.equal(saved.writes, writes);
  f.microphone.currentSnapshot = { heard: true, onsetMs: 300, quietMs: 100 };
  f.ui.pause.click();
  assert.equal(JSON.parse(saved.values.get(STORAGE_KEY)).progress.snapshot.quietMs, 100);
});

test('changing next-group repeats after completion keeps completed status across reload', async () => {
  const saved = storage(); const f = await page(saved);
  f.ui.start.click(); await flush();
  for (let turn = 0; turn < 4; turn++) { f.audio.end(); f.ui.finished.click(); }
  f.ui['repeats-select'].value = '1';
  f.ui['repeats-select'].dispatchEvent(new Event('change'));
  const reopened = await page(saved);
  assert.equal(reopened.ui.start.textContent, '重新开始这组');
  assert.equal(reopened.ui['repeats-select'].value, '1');
  assert.equal(reopened.audio.plays, 0);
});

test('invalid manifest shows reload and never requests audio or microphone', async () => {
  const f = await page(storage(), { content: [phrases[0], phrases[0]] });
  assert.equal(f.ui.start.textContent, '重新加载');
  assert.match(f.ui['load-detail'].textContent, /编号重复/);
  assert.equal(f.ui.next.disabled, true);
  assert.equal(f.audio.plays, 0);
  assert.equal(f.microphone.prepares, 0);
});

test('offline manifest can be retried without overwriting saved progress', async () => {
  const saved = storage({ version: 1, settings: { repeats: 2, silenceSeconds: 5 },
    progress: { phraseId: 'water', phase: 'playing', completed: 1, kind: 'scheduled' } });
  let calls = 0;
  const f = await page(saved, { fetcher: async () => {
    calls++;
    if (calls === 1) throw new Error('Offline');
    return { ok: true, json: async () => phrases };
  } });
  assert.equal(saved.writes, 0);
  f.ui.start.click(); f.ui.start.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(calls, 2);
  assert.equal(f.ui.phrase.textContent, '我想喝水。');
  assert.equal(f.ui.start.textContent, '继续');
  assert.equal(f.audio.plays, 0);
});

test('rapid next clicks advance once and leave one playback watchdog', async () => {
  const content = [...phrases, { id: 'rest', text: '我想休息。', audio: 'audio/rest.wav' }];
  const f = await page(storage(), { content });
  f.ui.start.click(); await flush();
  f.ui.next.click(); f.ui.next.click();
  assert.equal(f.audio.src, 'audio/water.wav');
  assert.equal(f.clock.tasks.size, 1);
  f.clock.advance(300); f.ui.next.click();
  assert.equal(f.audio.src, 'audio/rest.wav');
  assert.equal(f.clock.tasks.size, 1);
});

test('rapid replay clicks do not start duplicate playback', async () => {
  const f = await page(storage());
  f.ui.start.click(); await flush();
  f.ui.replay.click(); f.ui.replay.click();
  assert.equal(f.audio.plays, 2);
  assert.equal(f.clock.tasks.size, 1);
});

test('rapid Start clicks produce one microphone request and one playback', async () => {
  const f = await page(storage(), { deferMic: true });
  f.ui.start.click(); f.ui.start.dispatchEvent(new Event('click'));
  assert.equal(f.microphone.prepares, 1);
  f.releaseMicrophone(); await flush();
  assert.equal(f.audio.plays, 1);
});

test('audio timeout offers retry and next without advancing on its own', async () => {
  const saved = storage(); const f = await page(saved);
  f.ui.start.click(); await flush();
  f.clock.advance(20000);
  assert.match(f.ui.status.textContent, /超时/);
  assert.equal(f.ui.start.textContent, '重试这句');
  assert.equal(f.ui.next.disabled, false);
  assert.equal(JSON.parse(saved.values.get(STORAGE_KEY)).progress.phraseId, 'hello');
  f.ui.start.click(); await flush();
  assert.equal(f.audio.src, 'audio/hello.wav');
  assert.equal(f.audio.plays, 2);
});

test('background, freeze and cached-page return stay paused until a user continues', async () => {
  const f = await page(storage()); f.ui.start.click(); await flush();
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.audio.paused, true);
  assert.equal(f.microphone.ready, false);
  assert.equal(f.clock.tasks.size, 0);
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
  f.window.dispatchEvent(new Event('pageshow'));
  assert.equal(f.ui.start.textContent, '继续');
  assert.equal(f.audio.plays, 1);
  assert.equal(f.microphone.prepares, 1);
  f.ui.start.click(); await flush();
  assert.equal(f.audio.plays, 2);
  f.document.dispatchEvent(new Event('freeze'));
  assert.equal(f.ui.start.disabled, true);
  f.document.dispatchEvent(new Event('resume'));
  f.window.dispatchEvent(new Event('pagehide'));
  f.window.dispatchEvent(new Event('pageshow'));
  assert.equal(f.ui.start.textContent, '继续');
  assert.equal(f.audio.plays, 2);
});

test('background listening preserves its snapshot and rejects old completion', async () => {
  const saved = storage(); const f = await page(saved);
  f.ui.start.click(); await flush(); f.audio.end();
  const old = f.microphone.sessions[0];
  f.microphone.currentSnapshot = { heard: true, onsetMs: 300, quietMs: 1000 };
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  old.onComplete(); f.clock.advance(60000);
  assert.equal(f.audio.plays, 1);
  assert.equal(JSON.parse(saved.values.get(STORAGE_KEY)).progress.snapshot.quietMs, 1000);
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.audio.plays, 1);
  f.ui.start.click(); await flush();
  assert.equal(f.audio.plays, 1);
  assert.equal(f.microphone.sessions[1].initial.quietMs, 1000);
});

test('microphone permission arriving after a background switch cannot start playback', async () => {
  const f = await page(storage(), { deferMic: true });
  f.ui.start.click();
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  f.releaseMicrophone(); await flush();
  assert.equal(f.audio.plays, 1);
  assert.equal(f.audio.paused, true);
  assert.equal(f.microphone.ready, false);
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.audio.plays, 1);
  assert.equal(f.microphone.prepares, 1);
});

test('first playback starts immediately while microphone permission is pending', async () => {
  const f = await page(storage(), { deferMic: true });
  f.ui.start.click();
  assert.equal(f.audio.plays, 1);
  f.audio.end();
  assert.equal(f.microphone.sessions.length, 0);
  f.releaseMicrophone(); await flush();
  assert.equal(f.microphone.sessions.length, 1);
  assert.equal(f.audio.plays, 1);
});

test('manual mode during pending permission does not replay or reopen the microphone', async () => {
  const f = await page(storage(), { deferMic: true });
  f.ui.start.click(); f.audio.end();
  f.ui['manual-start'].click();
  assert.equal(f.audio.plays, 1);
  assert.equal(f.ui.finished.hidden, false);
  f.releaseMicrophone(); await flush();
  assert.equal(f.microphone.ready, false);
  f.ui.finished.click();
  assert.equal(f.audio.plays, 2);
});

test('system audio pause and microphone interruptions need explicit Continue', async () => {
  const f = await page(storage());
  f.ui.start.click(); await flush();
  f.audio.pause();
  assert.equal(f.ui.start.textContent, '继续');
  assert.equal(f.microphone.ready, false);
  f.ui.start.click(); await flush(); f.audio.end();
  f.microphone.onInterruption();
  assert.equal(f.ui.start.textContent, '继续');
  assert.equal(f.microphone.ready, false);
  assert.equal(f.audio.plays, 2);
});
