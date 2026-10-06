// Sound activity only: no speech recognition, recording, or network requests.
export class SpeechEndDetector {
  constructor({ silenceMs = 3000, threshold = 0.012, onsetMs = 300, initial, time = 0 } = {}) {
    Object.assign(this, { silenceMs, threshold, onsetMs });
    this.startedAt = null;
    this.lastSoundAt = null;
    this.heard = false;
    this.complete = false;
    if (initial) {
      this.heard = initial.heard;
      this.startedAt = initial.onsetMs == null ? null : time - initial.onsetMs;
      this.lastSoundAt = initial.quietMs == null ? null : time - initial.quietMs;
    }
  }
  snapshot(time) {
    return { heard: this.heard,
      onsetMs: this.startedAt === null ? null : Math.max(0, time - this.startedAt),
      quietMs: this.lastSoundAt === null ? null : Math.max(0, time - this.lastSoundAt) };
  }
  sample(level, time) {
    if (this.complete) return { heard: this.heard, complete: true };
    if (level >= this.threshold) {
      if (this.startedAt === null) this.startedAt = time;
      this.lastSoundAt = time;
      if (time - this.startedAt >= this.onsetMs) this.heard = true;
    } else if (!this.heard) this.startedAt = null;
    const quietMs = this.heard ? time - this.lastSoundAt : 0;
    this.complete = this.heard && quietMs >= this.silenceMs;
    return { heard: this.heard, complete: this.complete, quietMs };
  }
}

export class MicrophoneListener {
  constructor({ onInterruption = () => {} } = {}) {
    this.epoch = 0; this.frame = null;
    this.onInterruption = onInterruption;
    this.interruptionCleanup = [];
  }
  get ready() { return this.context?.state === 'running' && this.stream?.getAudioTracks().some(track => track.readyState === 'live'); }
  snapshot() { return this.detector?.snapshot(performance.now()); }
  async prepare(silenceMs) {
    this.close();
    const epoch = this.epoch;
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Unavailable');
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('Unavailable');
    const context = new AudioContext();
    this.context = context;
    try {
      await context.resume();
      if (epoch !== this.epoch) throw new Error('Cancelled');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (epoch !== this.epoch) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error('Cancelled');
      }
      this.stream = stream;
      this.silenceMs = silenceMs;
      this.source = context.createMediaStreamSource(stream);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.source.connect(this.analyser);
      this.buffer = new Float32Array(this.analyser.fftSize);
      this.observeInterruptions(context, stream);
      if (context.state !== 'running') throw new Error('Interrupted');
      this.stop();
    } catch (error) {
      if (epoch === this.epoch) this.close();
      throw error;
    }
  }
  observeInterruptions(context, stream) {
    const interrupt = () => {
      if (this.context !== context || this.stream !== stream) return;
      this.onInterruption();
      if (this.context === context) this.close();
    };
    const add = (target, type, handler) => {
      target.addEventListener?.(type, handler);
      this.interruptionCleanup.push(() => target.removeEventListener?.(type, handler));
    };
    add(context, 'statechange', () => { if (context.state !== 'running') interrupt(); });
    for (const track of stream.getAudioTracks()) {
      add(track, 'ended', interrupt);
      add(track, 'mute', () => { if (track.enabled) interrupt(); });
    }
  }
  start({ initial, onUpdate, onComplete, onError }) {
    this.stop();
    if (!this.stream || this.context?.state !== 'running' || !this.analyser) { this.close(); onError(); return; }
    const track = this.stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') { this.close(); onError(); return; }
    track.enabled = true;
    const epoch = this.epoch;
    const listenFrom = performance.now() + (initial ? 0 : 500);
    const detector = new SpeechEndDetector({ silenceMs: this.silenceMs, initial, time: listenFrom });
    this.detector = detector;
    const tick = () => {
      if (epoch !== this.epoch) return;
      if (track.readyState !== 'live' || this.context.state !== 'running') { this.close(); onError(); return; }
      const now = performance.now();
      if (now >= listenFrom) {
        let result;
        try {
          if (typeof this.analyser.getFloatTimeDomainData === 'function') this.analyser.getFloatTimeDomainData(this.buffer);
          else {
            this.byteBuffer ||= new Uint8Array(this.buffer.length);
            this.analyser.getByteTimeDomainData(this.byteBuffer);
            for (let i = 0; i < this.buffer.length; i++) this.buffer[i] = (this.byteBuffer[i] - 128) / 128;
          }
          const rms = Math.sqrt(this.buffer.reduce((sum, value) => sum + value * value, 0) / this.buffer.length);
          if (!Number.isFinite(rms)) throw new Error('Invalid signal');
          result = detector.sample(rms, now);
        } catch { this.close(); onError(); return; }
        onUpdate(result);
        if (epoch !== this.epoch) return;
        if (result.complete) { this.stop(); onComplete(); return; }
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
  stop() {
    this.epoch++;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = false; });
  }
  close() {
    for (const cleanup of this.interruptionCleanup) cleanup();
    this.interruptionCleanup = [];
    this.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    this.source?.disconnect();
    this.context?.close().catch(() => {});
    this.stream = null;
    this.source = null;
    this.context = null;
    this.detector = null;
    this.byteBuffer = null;
  }
}
