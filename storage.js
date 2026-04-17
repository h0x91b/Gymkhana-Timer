// Run history persisted in localStorage.
// Shape: [{ elapsed: number, startedAt: number, finishedAt: number }, ...]
//   elapsed     — run duration in seconds (mediaTime-based; authoritative)
//   startedAt   — wall-clock timestamp (epoch ms) when the run started
//   finishedAt  — wall-clock timestamp (epoch ms) when the run finished
//
// Retention policy: keep as many runs as localStorage can hold. If a write
// throws QuotaExceededError, trim the oldest entries in 10% chunks and retry
// until it fits — but never drop below MIN_KEEP (the latest N are always kept
// as long as they themselves fit). New runs are always appended to the tail,
// so a trim always discards the oldest results first.

const KEY = 'gymkhana.runs.v1';
const MIN_KEEP = 100;

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
    return this._persist(runs);
  }

  // Attempt to write `runs` to localStorage. On quota errors, trim the oldest
  // entries (10% at a time, at least 1) and retry. Returns the runs array that
  // actually landed in storage.
  _persist(runs) {
    // Fast path.
    try {
      localStorage.setItem(KEY, JSON.stringify(runs));
      return runs;
    } catch (err) {
      if (!isQuotaError(err)) {
        console.warn('Storage write failed (non-quota):', err);
        return runs;
      }
    }

    // Trim oldest until it fits, but stop at MIN_KEEP.
    console.warn('localStorage quota hit; trimming oldest runs.');
    while (runs.length > MIN_KEEP) {
      const drop = Math.max(1, Math.floor(runs.length * 0.1));
      runs.splice(0, drop);
      try {
        localStorage.setItem(KEY, JSON.stringify(runs));
        return runs;
      } catch (err) {
        if (!isQuotaError(err)) {
          console.warn('Storage write failed mid-trim:', err);
          return runs;
        }
      }
    }

    // At MIN_KEEP and still failing — try shrinking below the floor as a last
    // resort so the most recent run is not lost.
    while (runs.length > 1) {
      runs.shift();
      try {
        localStorage.setItem(KEY, JSON.stringify(runs));
        return runs;
      } catch (err) {
        if (!isQuotaError(err)) {
          console.warn('Storage write failed below floor:', err);
          return runs;
        }
      }
    }

    console.warn('Cannot persist runs — localStorage rejected even a single entry.');
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

// Browsers report quota exhaustion with slightly different names/codes.
function isQuotaError(err) {
  if (!err) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  );
}
