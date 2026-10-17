// Counts only active model/execution time. Human input does not consume it.
export class ActiveBudget {
  durationMs: number;
  expire: () => void;
  remaining: number;
  timer?: ReturnType<typeof setTimeout> | null;
  started = 0;
  constructor(durationMs: number, expire: () => void) { this.durationMs = durationMs; this.expire = expire; this.remaining = durationMs; }
  resume() {
    if (this.timer) return;
    this.started = Date.now();
    this.timer = setTimeout(() => { this.timer = null; this.remaining = 0; this.expire(); }, Math.max(0, this.remaining));
  }
  pause() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.started));
  }
  reset() { this.pause(); this.remaining = this.durationMs; this.resume(); }
}
