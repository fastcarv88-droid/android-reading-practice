// Returning to a visible page changes availability; it never resumes practice.
export class PageLifecycle {
  constructor({ document, window, onPause, onReturn }) {
    Object.assign(this, { document, onPause, onReturn });
    this.frozen = false;
    this.gone = false;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) onPause();
      else onReturn();
    });
    document.addEventListener('freeze', () => { this.frozen = true; onPause(); });
    document.addEventListener('resume', () => { this.frozen = false; onReturn(); });
    window.addEventListener('pagehide', () => { this.gone = true; onPause(); });
    window.addEventListener('pageshow', () => {
      this.gone = false;
      this.frozen = false;
      if (document.hidden) onPause();
      else onReturn();
    });
  }
  get available() { return !this.document.hidden && !this.frozen && !this.gone; }
}
