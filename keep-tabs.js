export class KeepCommand {
  constructor({ now = () => performance.now(), schedule = (callback, delay) => setTimeout(callback, delay), unschedule = timer => clearTimeout(timer) } = {}) {
    this.now = now;
    this.schedule = schedule;
    this.unschedule = unschedule;
    this.deadline = 0;
    this.timer = null;
  }
  arm() {
    this.cancel();
    this.deadline = this.now() + 5000;
    this.timer = this.schedule(() => this.cancel(), 5000);
  }
  get pending() {
    if (this.deadline && this.now() >= this.deadline) this.cancel();
    return this.deadline > 0;
  }
  consume() {
    const pending = this.pending;
    this.cancel();
    return pending;
  }
  cancel() {
    this.unschedule(this.timer);
    this.timer = null;
    this.deadline = 0;
  }
}

export function planKeepTabs(tabs, results, count) {
  if (!Number.isInteger(count) || count < 1 || count > 9 || !results.length) return null;
  return {
    scopeIds: tabs.map(tab => tab.id),
    keepIds: results.slice(0, count).map(tab => tab.id)
  };
}
