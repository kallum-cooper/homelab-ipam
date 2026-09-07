const SCAN_INTERVAL_MS = 300_000;

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must be a valid date');
  return date;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createScanManager({ scanner, store, now = () => new Date() }) {
  if (typeof scanner !== 'function') throw new TypeError('scanner is required');
  if (!store || typeof store.load !== 'function' || typeof store.recordScan !== 'function') {
    throw new TypeError('store is required');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  let inFlight = null;
  let interval = null;
  let status = {
    ok: true,
    entries: store.load().entries,
    lastSuccessfulScanAt: null,
    lastAttemptAt: null,
    scanInProgress: false,
    error: null,
  };

  function getStatus() {
    const current = status.scanInProgress
      ? validDate(status.lastAttemptAt)
      : validDate(now());
    return {
      ...status,
      entries: store.snapshot(current).entries,
    };
  }

  function scan() {
    if (inFlight) return inFlight;

    const attemptedAt = validDate(now());
    const lastAttemptAt = attemptedAt.toISOString();
    status = {
      ...status,
      entries: store.snapshot(attemptedAt).entries,
      lastAttemptAt,
      scanInProgress: true,
    };
    let result;
    try {
      result = scanner();
    } catch (error) {
      result = Promise.reject(error);
    }
    inFlight = Promise.resolve(result)
      .then((entries) => {
        const state = store.recordScan(entries, attemptedAt);
        status = {
          ok: true,
          entries: state.entries,
          lastSuccessfulScanAt: lastAttemptAt,
          lastAttemptAt,
          scanInProgress: false,
          error: null,
        };
        return getStatus();
      })
      .catch(error => {
        status = {
          ...status,
          ok: false,
          entries: store.snapshot(attemptedAt).entries,
          lastAttemptAt,
          scanInProgress: false,
          error: errorMessage(error),
        };
        return getStatus();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function start() {
    if (!interval) interval = setInterval(scan, SCAN_INTERVAL_MS);
    return scan();
  }

  function stop() {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
  }

  return { getStatus, scan, start, stop };
}
