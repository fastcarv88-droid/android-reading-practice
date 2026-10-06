export const STORAGE_KEY = 'slow-speech.practice.v1';
export const DEFAULT_SETTINGS = Object.freeze({ repeats: 2, silenceSeconds: 3 });

function settingsFrom(value) {
  return {
    repeats: [1, 2, 3].includes(value?.repeats) ? value.repeats : DEFAULT_SETTINGS.repeats,
    silenceSeconds: [2, 3, 5, 8].includes(value?.silenceSeconds) ? value.silenceSeconds : DEFAULT_SETTINGS.silenceSeconds,
  };
}

function snapshotFrom(value, silenceSeconds) {
  if (!value || typeof value.heard !== 'boolean') return undefined;
  const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (value.heard && !finite(value.quietMs)) return undefined;
  return {
    heard: value.heard,
    onsetMs: finite(value.onsetMs) ? Math.min(300, value.onsetMs) : null,
    quietMs: finite(value.quietMs) ? Math.min(silenceSeconds * 1000, value.quietMs) : null,
  };
}

export class LocalPracticeState {
  constructor(getStorage = () => globalThis.localStorage) { this.getStorage = getStorage; }

  read(phrases) {
    const fallback = (notice = '') => ({ settings: { ...DEFAULT_SETTINGS }, progress: null, notice });
    let source;
    try { source = this.getStorage().getItem(STORAGE_KEY); }
    catch { return fallback('unavailable'); }
    if (source === null) return fallback();
    let data;
    try { data = JSON.parse(source); }
    catch { return fallback('invalid'); }
    if (!data || data.version !== 1 || typeof data.settings !== 'object' || !data.settings) return fallback('invalid');
    const settings = settingsFrom(data.settings);
    const progress = data.progress;
    if (!progress || typeof progress.phraseId !== 'string') return { settings, progress: null, notice: 'invalid' };
    const index = phrases.findIndex(phrase => phrase.id === progress.phraseId);
    const pausedStart = (index, notice) => ({ settings, progress: {
      index, phase: 'paused', resumePhase: 'playing', completed: 0, kind: 'scheduled',
    }, notice });
    if (index < 0) return pausedStart(0, 'changed');
    if (!['idle', 'playing', 'listening', 'paused', 'error', 'complete'].includes(progress.phase)
      || !['scheduled', 'extra'].includes(progress.kind)
      || !Number.isInteger(progress.completed) || progress.completed < 0 || progress.completed > settings.repeats) return pausedStart(index, 'invalid');
    const resumePhase = ['playing', 'listening'].includes(progress.phase) ? progress.phase : progress.resumePhase;
    if (!['idle', 'complete'].includes(progress.phase)) {
      if (!['playing', 'listening'].includes(resumePhase)
        || (progress.kind === 'scheduled' && ((resumePhase === 'playing' && progress.completed >= settings.repeats)
          || (resumePhase === 'listening' && progress.completed === 0)))) return pausedStart(index, 'invalid');
    }
    return { settings, notice: '', progress: {
      index, phase: progress.phase === 'complete' ? 'complete' : progress.phase === 'idle' ? 'idle' : 'paused',
      resumePhase, completed: progress.phase === 'idle' ? 0 : progress.completed,
      kind: progress.phase === 'idle' ? 'scheduled' : progress.kind,
      snapshot: snapshotFrom(progress.snapshot, settings.silenceSeconds),
    } };
  }

  write(practice, settings) {
    if (!practice.phrases.length) return false;
    try {
      this.getStorage().setItem(STORAGE_KEY, JSON.stringify({ version: 1,
        settings: settingsFrom(settings), progress: practice.checkpoint() }));
      return true;
    } catch { return false; }
  }
}
