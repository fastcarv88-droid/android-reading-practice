import { GroupPractice } from './group-practice.mjs';
import { MicrophoneListener } from './speech-end.mjs';
import { LocalPracticeState } from './local-state.mjs';
import { loadPhrases, ContentError } from './content-loader.mjs';
import { PageLifecycle } from './page-lifecycle.mjs';

const ui = Object.fromEntries(['phrase', 'progress', 'status', 'countdown', 'start', 'pause', 'replay', 'next', 'finished', 'manual-start', 'phrase-select', 'silence-select', 'repeats-select', 'reset', 'save-status', 'load-detail'].map(id => [id, document.getElementById(id)]));
const audio = new Audio();
audio.preload = 'auto';
let lifecycle;
const pageAvailable = () => lifecycle ? lifecycle.available : !document.hidden;
const microphone = new MicrophoneListener({ onInterruption: () => pause('interrupted') });
const localState = new LocalPracticeState();
let preparing = false;
let pendingListening = null;
let request = 0;
let useMicrophone = true;
let pendingAction = null;
let loading = true;
let state = { phase: 'idle', index: 0, total: 0 };
let savedSignature = '';
let saveFailed = false;
let storageNotice = '';
let contentProblem = null;
const lastActions = new Map();
const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };

const listener = {
  start(callbacks) {
    if (preparing) pendingListening = callbacks;
    else if (!useMicrophone) callbacks.onError();
    else microphone.start(callbacks);
  },
  stop() { pendingListening = null; microphone.stop(); },
  snapshot() { return pendingListening?.initial || microphone.snapshot(); },
};
const practice = new GroupPractice({ audio, listener, canRun: pageAvailable, onState(nextState) {
  state = nextState;
  if (state.manual) { useMicrophone = false; microphone.close(); }
  if (['paused', 'error', 'complete'].includes(state.phase)) microphone.close();
  if (state.phase === 'complete') ui['phrase-select'].selectedIndex = 0;
  render();
  saveProgress();
} });

function settings() {
  return { repeats: Number(ui['repeats-select'].value), silenceSeconds: Number(ui['silence-select'].value) };
}

function updateSaveStatus() {
  text(ui['save-status'], saveFailed ? '当前浏览器无法保存设置和进度，关闭后可能丢失。'
    : storageNotice || (practice.phrases.length ? '设置和练习进度已保存在当前浏览器中。' : ''));
}

function saveProgress(force = false) {
  if (loading || !practice.phrases.length) return;
  // Save meaningful changes and explicit pauses, not every microphone sample.
  const signature = JSON.stringify([state.phase, state.index, state.completed, state.kind,
    practice.saved?.phase, Boolean(state.heard), Boolean(state.manual), settings()]);
  if (!force && signature === savedSignature) return;
  savedSignature = signature;
  saveFailed = !localState.write(practice, settings());
  updateSaveStatus();
}

function render() {
  const available = pageAvailable();
  const ready = !loading && practice.phrases.length > 0;
  const busy = practice.active;
  const locked = !available || loading || preparing || busy || ['paused', 'error'].includes(state.phase);
  ui.start.disabled = !available || loading || preparing || busy;
  ui.start.hidden = state.phase === 'listening';
  ui.pause.disabled = !preparing && !busy;
  ui.replay.disabled = !available || !ready || preparing || state.phase === 'complete';
  ui.next.disabled = !available || !ready || preparing || state.phase === 'complete';
  ui.reset.disabled = !available || !ready || preparing;
  ui['phrase-select'].disabled = !ready || locked;
  ui['silence-select'].disabled = locked;
  ui['repeats-select'].disabled = locked;
  ui.finished.hidden = state.phase !== 'listening' || preparing;
  ui.finished.disabled = !available;
  ui['manual-start'].hidden = pendingAction === null;
  ui['manual-start'].disabled = !available;
  if (state.phrase) text(ui.phrase, state.phrase.text);
  if (ready) {
    text(ui.progress, `第 ${state.index + 1} / ${state.total} 句 · ${state.kind === 'extra' && busy ? '额外示范' : `示范 ${state.round || 1} / ${state.repeats || 2} 遍`}`);
    if (busy || ['paused', 'error'].includes(state.phase)) ui['phrase-select'].selectedIndex = state.index;
  }
  text(ui.countdown, state.phase === 'listening' && useMicrophone && state.heard ? '安静片刻后自动继续' : '');
  const messages = {
    idle: '准备好了，点击开始',
    playing: state.kind === 'extra' ? '请听额外示范' : '请听示范',
    listening: !useMicrophone ? '慢慢说，说完后点击“我说完了”' : state.heard ? '检测到声音，请慢慢说' : '轮到你了，慢慢说',
    paused: state.pauseReason === 'group-break' ? '已到下一组，先歇一会儿；准备好再点击继续'
      : state.pauseReason === 'background' ? '练习已暂停，返回后请点击继续'
      : state.pauseReason === 'interrupted' ? '声音或麦克风被中断，请点击继续' : '练习已暂停，点击继续',
    error: state.problem === 'timeout' ? '这句音频加载或播放超时，请重试或下一句'
      : state.problem === 'blocked' ? '浏览器暂未允许播放，请点击“重试这句”'
      : '这句音频暂时无法播放，请重试或下一句',
    complete: '这一组结束了，可以休息一下',
  };
  text(ui.status, loading ? '正在加载练习内容…' : preparing && state.phase !== 'playing' ? '请允许使用麦克风，或选择手动确认' : messages[state.phase]);
  const labels = { idle: '开始练习', playing: '正在练习', listening: '正在练习', paused: '继续', error: '重试这句', complete: '重新开始这组' };
  text(ui.start, pendingAction && !preparing ? '重试麦克风' : labels[state.phase]);
  if (contentProblem && !loading) {
    text(ui.status, '练习内容加载失败，请重新加载');
    text(ui.start, '重新加载');
    text(ui['load-detail'], contentProblem);
    ui['load-detail'].hidden = false;
  }
  updateSaveStatus();
}

async function run(action) {
  if (!pageAvailable()) { pause('background'); return; }
  if (preparing || loading || !practice.phrases.length) return;
  if (!useMicrophone || microphone.ready) {
    pendingAction = null;
    action();
    return;
  }
  if (practice.active) practice.pause();
  const token = ++request;
  preparing = true;
  pendingAction = action;
  render();
  // Request permission and play in the same click, without waiting for the mic.
  const preparation = microphone.prepare(Number(ui['silence-select'].value) * 1000);
  action();
  try {
    await preparation;
    if (token !== request) return;
    if (!pageAvailable()) { pause('background'); return; }
    preparing = false;
    pendingAction = null;
    const callbacks = pendingListening;
    pendingListening = null;
    if (callbacks) microphone.start(callbacks);
    render();
  } catch {
    if (token !== request) return;
    preparing = false;
    pendingAction = null;
    useMicrophone = false;
    microphone.close();
    const callbacks = pendingListening;
    pendingListening = null;
    if (callbacks) callbacks.onError();
    render();
    if (state.phase === 'playing') text(ui.status, '请听示范；麦克风未启用，稍后点击“我说完了”');
    else if (state.phase === 'listening') text(ui.status, '麦克风未启用，说完后点击“我说完了”');
  }
}

ui.start.addEventListener('click', () => {
  if (!pageAvailable()) { pause('background'); return; }
  if (loading) return;
  if (!practice.phrases.length) { loadContent(); return; }
  storageNotice = '';
  if (state.phase === 'complete') useMicrophone = true;
  const action = pendingAction || (() => {
    if (['paused', 'error'].includes(practice.phase)) practice.resume();
    else practice.start(ui['phrase-select'].selectedIndex, Number(ui['repeats-select'].value));
  });
  run(action);
});

function pause(reason = 'button') {
  request++;
  preparing = false;
  pendingAction = null;
  if (practice.active) practice.pause(reason);
  else { microphone.close(); render(); saveProgress(true); }
}
ui.pause.addEventListener('click', () => pause('button'));
function allowNavigation(name) {
  if (!pageAvailable()) { pause('background'); return false; }
  if (loading || preparing || !practice.phrases.length || state.phase === 'complete') return false;
  const now = performance.now();
  if (now - (lastActions.get(name) ?? -Infinity) < 300) return false;
  lastActions.set(name, now);
  return true;
}
ui.replay.addEventListener('click', () => { if (allowNavigation('replay')) run(() => practice.replay()); });
ui.next.addEventListener('click', () => {
  if (!allowNavigation('next')) return;
  // Advancing from the final sentence needs no microphone permission.
  if (practice.index === practice.phrases.length - 1) { pendingAction = null; practice.next(); }
  else run(() => practice.next());
});
ui.finished.addEventListener('click', () => {
  if (!pageAvailable()) { pause('background'); return; }
  practice.finishSpeaking();
});
ui['manual-start'].addEventListener('click', () => {
  if (!pageAvailable()) { pause('background'); return; }
  const action = pendingAction;
  if (!action) return;
  request++;
  preparing = false;
  pendingAction = null;
  useMicrophone = false;
  microphone.close();
  const callbacks = pendingListening;
  pendingListening = null;
  if (callbacks) callbacks.onError();
  render();
});
ui['phrase-select'].addEventListener('change', () => {
  practice.index = ui['phrase-select'].selectedIndex;
  practice.completed = 0;
  practice.phase = 'idle';
  practice.kind = 'scheduled';
  useMicrophone = true;
  practice.emit();
});
ui['repeats-select'].addEventListener('change', () => {
  practice.repeats = Number(ui['repeats-select'].value);
  practice.emit();
});
ui['silence-select'].addEventListener('change', () => saveProgress(true));
ui.reset.addEventListener('click', () => {
  if (!pageAvailable()) { pause('background'); return; }
  request++;
  preparing = false;
  pendingAction = null;
  useMicrophone = true;
  storageNotice = '';
  lastActions.clear();
  microphone.close();
  ui['phrase-select'].selectedIndex = 0;
  practice.reset();
  saveProgress(true);
});
lifecycle = new PageLifecycle({ document, window, onPause: () => pause('background'),
  onReturn: () => { lastActions.clear(); render(); } });
audio.addEventListener('pause', () => {
  if (!practice.canceling && practice.phase === 'playing' && audio.paused && !audio.ended) pause('interrupted');
});

async function loadContent() {
  loading = true;
  contentProblem = null;
  render();
  ui['load-detail'].hidden = true;
  text(ui.status, '正在加载练习内容…');
  try {
    const phrases = await loadPhrases({ fetcher: fetch });
    practice.phrases = phrases;
    if (document.createElement && document.head) {
      for (const phrase of phrases.slice(0, 10)) {
        const hint = document.createElement('link');
        hint.rel = 'prefetch';
        hint.as = 'audio';
        hint.href = phrase.audio;
        document.head.appendChild(hint);
      }
    }
    const groupNames = ['请字衔接', '请字短句', '问候回应', '喝水吃饭', '休息感受', '表达需要', '交流节奏', '家人陪伴', '日常活动', '练习反馈'];
    ui['phrase-select'].replaceChildren(...phrases.map((p, i) => new Option(`${i + 1}. ${groupNames[Math.floor(i / 10)] || '短句'} · ${p.text}`, p.id)));
    const restored = localState.read(phrases);
    ui['repeats-select'].value = String(restored.settings.repeats);
    ui['silence-select'].value = String(restored.settings.silenceSeconds);
    ui['phrase-select'].selectedIndex = restored.progress?.index || 0;
    practice.repeats = restored.settings.repeats;
    storageNotice = { changed: '原短句已移除，已回到第一句并暂停。',
      invalid: '部分保存记录无法读取，请检查设置；练习尚未开始。',
      unavailable: '当前浏览器无法读取本机保存记录。' }[restored.notice] || '';
    loading = false;
    if (restored.progress) practice.restore(restored.progress, restored.settings.repeats);
    else practice.emit();
    // Warm the selected clip before the first click; never autoplay here.
    audio.src = phrases[practice.index].audio;
    practice.loadedSource = phrases[practice.index].audio;
    audio.load?.();
  } catch (error) {
    loading = false;
    practice.phrases = [];
    contentProblem = error instanceof ContentError ? error.publicMessage : '请检查网络后重新加载。';
    render();
    text(ui.phrase, '请重新加载');
    text(ui.status, '练习内容加载失败，请重新加载');
    text(ui.start, '重新加载');
    text(ui['load-detail'], error instanceof ContentError ? error.publicMessage : '请检查网络后重新加载。');
    ui['load-detail'].hidden = false;
  }
}
loadContent();
