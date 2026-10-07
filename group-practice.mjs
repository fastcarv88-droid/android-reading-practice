export class GroupPractice {
  constructor({ audio, listener, onState, phrases = [], repeats = 2, clock = globalThis, timeoutMs = 20000, canRun = () => true }) {
    Object.assign(this, { audio, listener, onState, phrases, repeats, clock, timeoutMs, canRun });
    this.phase = 'idle';
    this.index = 0;
    this.completed = 0;
    this.kind = 'scheduled';
    this.generation = 0;
    this.playbackTimer = null;
    audio.addEventListener('ended', () => {
      if (this.phase !== 'playing' || audio.ended === false) return;
      if (!this.canRun()) { this.pause('background'); return; }
      if (this.kind === 'scheduled') this.completed++;
      this.listen();
    });
    audio.addEventListener('error', () => { if (this.phase === 'playing' && audio.error !== null) this.fail('audio'); });
    audio.addEventListener('playing', () => {
      if (!this.canRun()) { if (this.active) this.pause('background'); else audio.pause(); return; }
      if (this.phase !== 'playing') { audio.pause(); return; }
      this.watchPlayback();
    });
    audio.addEventListener('timeupdate', () => {
      if (this.phase === 'playing' && audio.currentTime > this.lastPlaybackTime) {
        this.lastPlaybackTime = audio.currentTime;
        this.watchPlayback();
      }
    });
  }

  get active() { return this.phase === 'playing' || this.phase === 'listening'; }

  checkpoint() {
    return { phraseId: this.phrases[this.index]?.id, phase: this.phase, completed: this.phase === 'complete' ? 0 : this.completed, kind: this.kind,
      resumePhase: this.saved?.phase || (this.active ? this.phase : undefined),
      snapshot: this.phase === 'listening' ? (this.listenerStarted ? this.listener.snapshot?.() : this.listeningSnapshot) : this.saved?.snapshot };
  }

  restore(progress, repeats = this.repeats) {
    this.cancel();
    this.repeats = repeats;
    this.index = progress.index;
    this.completed = progress.completed;
    this.kind = progress.kind;
    this.phase = progress.phase;
    this.saved = this.phase === 'paused' ? { phase: progress.resumePhase, kind: progress.kind, snapshot: progress.snapshot } : null;
    this.emit();
  }

  reset() {
    this.cancel();
    this.index = 0;
    this.completed = 0;
    this.kind = 'scheduled';
    this.phase = 'idle';
    this.saved = null;
    this.emit();
  }

  emit(extra = {}) {
    this.onState({ phase: this.phase, index: this.index, total: this.phrases.length,
      completed: this.completed, round: Math.min(this.repeats, this.completed + ((this.phase === 'playing' || this.saved?.phase === 'playing') && this.kind === 'scheduled' ? 1 : 0)) || 1,
      repeats: this.repeats, kind: this.kind, phrase: this.phrases[this.index], problem: this.problem, pauseReason: this.pauseReason, ...extra });
  }

  clearPlaybackTimer() {
    if (this.playbackTimer !== null) this.clock.clearTimeout(this.playbackTimer);
    this.playbackTimer = null;
  }

  watchPlayback() {
    this.clearPlaybackTimer();
    const generation = this.generation;
    this.playbackTimer = this.clock.setTimeout(() => {
      if (generation !== this.generation || this.phase !== 'playing') return;
      if (!this.canRun()) this.pause('background');
      else this.fail('timeout');
    }, this.timeoutMs);
  }

  cancel() {
    this.generation++;
    this.clearPlaybackTimer();
    this.listenerStarted = false;
    this.listener.stop();
    this.canceling = true;
    try { this.audio.pause(); } finally { this.canceling = false; }
  }

  start(index = 0, repeats = this.repeats) {
    if (this.active || !this.phrases.length) return;
    this.index = Math.max(0, Math.min(index, this.phrases.length - 1));
    this.repeats = Math.max(1, Math.min(3, Number(repeats) || 2));
    this.completed = 0;
    this.saved = null;
    this.play('scheduled');
  }

  play(kind) {
    this.cancel();
    this.kind = kind;
    this.problem = undefined;
    this.pauseReason = undefined;
    this.phase = 'playing';
    if (!this.canRun()) { this.pause('background'); return; }
    const generation = this.generation;
    try {
      const source = this.phrases[this.index].audio;
      // Setting src again discards the already buffered audio on every repeat.
      if (this.loadedSource !== source) {
        this.audio.src = source;
        this.loadedSource = source;
      }
      this.audio.currentTime = 0;
      this.lastPlaybackTime = 0;
      this.emit();
      if (generation !== this.generation || this.phase !== 'playing') return;
      if (!this.canRun()) { this.pause('background'); return; }
      this.watchPlayback();
      Promise.resolve(this.audio.play()).then(() => {
        if (generation === this.generation && this.phase === 'playing' && !this.canRun()) this.pause('background');
      }, error => {
        if (generation === this.generation && this.phase === 'playing') this.fail(error?.name === 'NotAllowedError' ? 'blocked' : 'audio');
      });
    } catch { this.fail(); }
  }

  listen(snapshot) {
    this.clearPlaybackTimer();
    this.listeningSnapshot = snapshot;
    this.listenerStarted = false;
    this.phase = 'listening';
    if (!this.canRun()) { this.pause('background'); return; }
    const generation = this.generation;
    this.emit({ heard: snapshot?.heard || false });
    if (generation !== this.generation || this.phase !== 'listening') return;
    if (!this.canRun()) { this.pause('background'); return; }
    const active = () => generation === this.generation && this.phase === 'listening';
    try {
      this.listener.start({ initial: snapshot,
        onUpdate: state => { if (active()) this.emit(state); },
        onComplete: () => { if (active()) this.finishSpeaking(); },
        onError: () => { if (active()) this.emit({ manual: true }); },
      });
      this.listenerStarted = active();
    } catch { this.emit({ manual: true }); }
  }

  finishSpeaking() {
    if (this.phase !== 'listening') return;
    if (!this.canRun()) { this.pause('background'); return; }
    this.cancel();
    if (this.completed < this.repeats) this.play('scheduled');
    else this.next();
  }

  pause(reason = 'button') {
    if (!this.active) return;
    this.pauseReason = reason;
    this.saved = { phase: this.phase, kind: this.kind,
      snapshot: this.phase === 'listening' ? this.checkpoint().snapshot : undefined };
    this.cancel();
    this.phase = 'paused';
    this.emit();
  }

  resume() {
    if (!['paused', 'error'].includes(this.phase) || !this.saved) return;
    const saved = this.saved;
    this.saved = null;
    this.pauseReason = undefined;
    if (saved.phase === 'listening') {
      this.kind = saved.kind;
      this.listen(saved.snapshot);
    } else this.play(saved.kind);
  }

  replay() {
    if (!this.phrases.length || this.phase === 'complete') return;
    this.saved = null;
    this.play('extra');
  }

  next() {
    if (!this.phrases.length || this.phase === 'complete') return;
    this.cancel();
    this.saved = null;
    if (this.index + 1 >= this.phrases.length) {
      this.phase = 'complete';
      this.emit();
      return;
    }
    this.index++;
    this.completed = 0;
    if (this.index % 10 === 0) {
      this.kind = 'scheduled';
      this.phase = 'playing';
      this.pause('group-break');
      return;
    }
    this.play('scheduled');
  }

  fail(problem = 'audio') {
    this.problem = problem;
    this.saved = { phase: 'playing', kind: this.kind };
    this.cancel();
    this.phase = 'error';
    this.emit();
  }
}
