import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test('page polls status and disables Scan now while POST /api/scan is running', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'expected one inline page script');

  const listeners = new Map();
  const elements = new Map([
    ['#scan-button', {
      disabled: false,
      addEventListener(event, listener) {
        listeners.set(event, listener);
      },
    }],
    ['#status', { dataset: {}, textContent: '' }],
    ['#last-attempt', { textContent: '' }],
    ['#last-success', { textContent: '' }],
    ['#entries', { replaceChildren() {} }],
  ]);
  const requests = [];
  const scanResponse = deferred();
  let interval;
  const status = {
    ok: true,
    entries: [],
    lastAttemptAt: null,
    lastSuccessfulScanAt: null,
    scanInProgress: false,
    error: null,
  };
  const context = {
    document: {
      createElement: () => ({ textContent: '', append() {} }),
      querySelector: selector => elements.get(selector),
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/scan') return scanResponse.promise;
      return { ok: true, json: async () => status };
    },
    AbortSignal: { timeout: milliseconds => ({ milliseconds }) },
    setInterval(callback, milliseconds) {
      interval = { callback, milliseconds };
      return 1;
    },
  };

  new vm.Script(script).runInNewContext(context);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requests[0].url, '/api/status');
  assert.equal(interval.milliseconds, 60_000);
  await interval.callback();
  assert.equal(requests.filter(({ url }) => url === '/api/status').length, 2);

  const click = listeners.get('click')();
  assert.equal(elements.get('#scan-button').disabled, true);
  assert.equal(requests.at(-1).url, '/api/scan');
  assert.equal(requests.at(-1).options.method, 'POST');

  scanResponse.resolve({ ok: true, json: async () => status });
  await click;
  assert.equal(elements.get('#scan-button').disabled, false);
});

test('page keeps Scan now disabled after POST timeout until status reports scan complete', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'expected one inline page script');

  const listeners = new Map();
  const elements = new Map([
    ['#scan-button', {
      disabled: false,
      addEventListener(event, listener) {
        listeners.set(event, listener);
      },
    }],
    ['#status', { dataset: {}, textContent: '' }],
    ['#last-attempt', { textContent: '' }],
    ['#last-success', { textContent: '' }],
    ['#entries', { replaceChildren() {} }],
  ]);
  const idleStatus = {
    ok: true,
    entries: [],
    lastAttemptAt: null,
    lastSuccessfulScanAt: null,
    scanInProgress: false,
    error: null,
  };
  const runningStatus = { ...idleStatus, scanInProgress: true };
  const statusResponses = [idleStatus, runningStatus, idleStatus];
  const scanResponse = deferred();
  const timers = [];
  const requests = [];
  const context = {
    document: {
      createElement: () => ({ textContent: '', append() {} }),
      querySelector: selector => elements.get(selector),
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/scan') return scanResponse.promise;
      return { ok: true, json: async () => statusResponses.shift() };
    },
    AbortSignal: { timeout: milliseconds => ({ milliseconds }) },
    setInterval() {
      return 1;
    },
    setTimeout(callback, milliseconds) {
      timers.push({ callback, milliseconds });
      return timers.length;
    },
  };

  new vm.Script(script).runInNewContext(context);
  await new Promise(resolve => setImmediate(resolve));

  const click = listeners.get('click')();
  scanResponse.reject(new Error('The operation was aborted due to timeout'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(elements.get('#scan-button').disabled, true);
  assert.equal(requests.filter(({ url }) => url === '/api/status').length, 2);
  assert.equal(timers.length, 1);

  timers.shift().callback();
  await click;

  assert.equal(requests.filter(({ url }) => url === '/api/status').length, 3);
  assert.equal(elements.get('#scan-button').disabled, false);
});
