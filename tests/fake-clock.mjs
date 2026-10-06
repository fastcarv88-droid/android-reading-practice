export class FakeClock {
  constructor() { this.now = 0; this.serial = 0; this.tasks = new Map(); }
  setTimeout(fn, delay) { const id = ++this.serial; this.tasks.set(id, { at: this.now + delay, fn }); return id; }
  clearTimeout(id) { this.tasks.delete(id); }
  advance(ms) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.now = next[1].at;
      this.tasks.delete(next[0]);
      next[1].fn();
    }
    this.now = target;
  }
}
