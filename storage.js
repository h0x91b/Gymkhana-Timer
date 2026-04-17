// Run history persisted in localStorage.
// Shape: [{ elapsed: number, at: number (epoch ms) }, ...]

const KEY = 'gymkhana.runs.v1';

export class Storage {
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  save(run) {
    const runs = this.load();
    runs.push(run);
    localStorage.setItem(KEY, JSON.stringify(runs));
    return runs;
  }

  clear() {
    localStorage.removeItem(KEY);
  }

  best() {
    const runs = this.load();
    if (runs.length === 0) return null;
    return runs.reduce((a, b) => (a.elapsed <= b.elapsed ? a : b));
  }
}
