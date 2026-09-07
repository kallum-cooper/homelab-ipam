import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createScanManager } from '../scan-manager.mjs';
import { configurationFromEnv } from '../run.mjs';
import { createRequestHandler } from '../server.mjs';
import { createStateStore } from '../state.mjs';

async function fixture(scanner = async () => []) {
  const directory = await mkdtemp(join(tmpdir(), 'ipam-server-'));
  const store = createStateStore(join(directory, 'state.json'));
  const manager = createScanManager({
    scanner,
    store,
    now: () => new Date('2026-09-02T08:00:00.000Z'),
  });
  const indexPath = join(directory, 'index.html');
  await writeFile(indexPath, '<!doctype html><title>IPAM</title>\n', 'utf8');
  return { directory, indexPath, manager, store };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function waitFor(condition, description, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('service configuration reads every supported IPAM environment variable', () => {
  assert.deepEqual(configurationFromEnv({
    IPAM_PORT: '9876',
    IPAM_HOST: '127.0.0.1',
    IPAM_DATA_PATH: '/tmp/ipam-state.json',
    IPAM_SCAN_COMMAND: '/usr/local/bin/scan-lan',
    IPAM_SCAN_ARGS_JSON: '["--subnet","192.168.1.0/24"]',
    IPAM_SCAN_TIMEOUT_MS: '4500',
    UNIFI_BASE_URL: 'https://unifi.example.test',
    UNIFI_API_KEY: 'secret-not-used-in-test',
    UNIFI_CLIENTS_PATH: '/api/clients',
  }), {
    port: 9876,
    host: '127.0.0.1',
    dataPath: '/tmp/ipam-state.json',
    scanCommand: '/usr/local/bin/scan-lan',
    scanArgs: ['--subnet', '192.168.1.0/24'],
    scanTimeoutMs: 4_500,
    unifiBaseUrl: 'https://unifi.example.test',
    unifiApiKey: 'secret-not-used-in-test',
    unifiClientsPath: '/api/clients',
    unifiCaCertPath: '/run/secrets/unifi-ca.pem',
  });
});

test('GET /api/status returns the current state with JSON no-store headers', async (t) => {
  const { indexPath, manager, store } = await fixture();
  store.recordScan([{ id: 'host-1', ip: '192.168.1.10' }], new Date('2026-09-02T07:55:00.000Z'));
  const server = await listen(createRequestHandler({ manager, store, indexPath }));
  t.after(server.close);

  const response = await fetch(`${server.origin}/api/status`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json\b/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    entries: [{
      id: 'host-1',
      ip: '192.168.1.10',
      lastSeenAt: '2026-09-02T07:55:00.000Z',
    }],
    lastSuccessfulScanAt: null,
    lastAttemptAt: null,
    scanInProgress: false,
    error: null,
  });
});

test('POST /api/scan awaits and returns a successful manual scan', async (t) => {
  const { indexPath, manager, store } = await fixture(async () => [
    { id: 'host-1', ip: '192.168.1.10' },
  ]);
  const server = await listen(createRequestHandler({ manager, store, indexPath }));
  t.after(server.close);

  const response = await fetch(`${server.origin}/api/scan`, { method: 'POST' });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    entries: [{
      id: 'host-1',
      ip: '192.168.1.10',
      lastSeenAt: '2026-09-02T08:00:00.000Z',
    }],
    lastSuccessfulScanAt: '2026-09-02T08:00:00.000Z',
    lastAttemptAt: '2026-09-02T08:00:00.000Z',
    scanInProgress: false,
    error: null,
  });
});

test('concurrent POST /api/scan requests share one in-flight scan', async (t) => {
  let scannerCalls = 0;
  let resolveScanner;
  const scannerResult = new Promise(resolve => {
    resolveScanner = resolve;
  });
  const { indexPath, manager, store } = await fixture(() => {
    scannerCalls += 1;
    return scannerResult;
  });
  const server = await listen(createRequestHandler({ manager, store, indexPath }));
  t.after(server.close);

  const first = fetch(`${server.origin}/api/scan`, { method: 'POST' });
  const second = fetch(`${server.origin}/api/scan`, { method: 'POST' });
  await waitFor(() => scannerCalls === 1, 'the shared scan to start');

  assert.equal(scannerCalls, 1);
  const inProgress = await fetch(`${server.origin}/api/status`);
  assert.equal((await inProgress.json()).scanInProgress, true);
  resolveScanner([]);
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
});

test('GET /api/status reflects metadata from periodic manager.start scans', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ipam-server-periodic-'));
  const store = createStateStore(join(directory, 'state.json'));
  const scanTimes = [
    new Date('2026-09-02T08:00:00.000Z'),
    new Date('2026-09-02T08:05:00.000Z'),
    new Date('2026-09-02T08:10:00.000Z'),
  ];
  let scannerCalls = 0;
  let resolvePeriodicScan;
  const periodicResult = new Promise(resolve => {
    resolvePeriodicScan = resolve;
  });
  const manager = createScanManager({
    scanner: async () => {
      scannerCalls += 1;
      if (scannerCalls === 1) return [{ id: 'host-1', ip: '192.168.1.10' }];
      if (scannerCalls === 2) return periodicResult;
      throw new Error('periodic scanner failed');
    },
    store,
    now: () => scanTimes[Math.min(scannerCalls, scanTimes.length - 1)],
  });
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let scheduledScan;
  globalThis.setInterval = (callback) => {
    scheduledScan = callback;
    return { periodic: true };
  };
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  await manager.start();
  globalThis.setInterval = originalSetInterval;
  const server = await listen(createRequestHandler({ manager, store }));
  t.after(server.close);

  const periodicScan = scheduledScan();
  await waitFor(() => scannerCalls === 2, 'the periodic scan to start');
  const inProgress = await fetch(`${server.origin}/api/status`);
  assert.deepEqual(await inProgress.json(), {
    ok: true,
    entries: [{
      id: 'host-1',
      ip: '192.168.1.10',
      lastSeenAt: '2026-09-02T08:00:00.000Z',
    }],
    lastSuccessfulScanAt: '2026-09-02T08:00:00.000Z',
    lastAttemptAt: '2026-09-02T08:05:00.000Z',
    scanInProgress: true,
    error: null,
  });

  resolvePeriodicScan([{ id: 'host-2', ip: '192.168.1.11' }]);
  await periodicScan;
  const successful = await fetch(`${server.origin}/api/status`);
  assert.deepEqual(await successful.json(), {
    ok: true,
    entries: [
      {
        id: 'host-1',
        ip: '192.168.1.10',
        lastSeenAt: '2026-09-02T08:00:00.000Z',
      },
      {
        id: 'host-2',
        ip: '192.168.1.11',
        lastSeenAt: '2026-09-02T08:05:00.000Z',
      },
    ],
    lastSuccessfulScanAt: '2026-09-02T08:05:00.000Z',
    lastAttemptAt: '2026-09-02T08:05:00.000Z',
    scanInProgress: false,
    error: null,
  });

  await scheduledScan();
  const failed = await fetch(`${server.origin}/api/status`);
  assert.deepEqual(await failed.json(), {
    ok: false,
    entries: [
      {
        id: 'host-1',
        ip: '192.168.1.10',
        lastSeenAt: '2026-09-02T08:00:00.000Z',
      },
      {
        id: 'host-2',
        ip: '192.168.1.11',
        lastSeenAt: '2026-09-02T08:05:00.000Z',
      },
    ],
    lastSuccessfulScanAt: '2026-09-02T08:05:00.000Z',
    lastAttemptAt: '2026-09-02T08:10:00.000Z',
    scanInProgress: false,
    error: 'periodic scanner failed',
  });
});

test('GET / serves the configured index.html', async (t) => {
  const { indexPath, manager, store } = await fixture();
  const server = await listen(createRequestHandler({ manager, store, indexPath }));
  t.after(server.close);

  const response = await fetch(`${server.origin}/`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html\b/);
  assert.equal(await response.text(), '<!doctype html><title>IPAM</title>\n');
});

test('unknown paths return a bounded 404 response', async (t) => {
  const { indexPath, manager, store } = await fixture();
  const server = await listen(createRequestHandler({ manager, store, indexPath }));
  t.after(server.close);
  const untrustedPath = `/${'x'.repeat(2_000)}`;

  const response = await fetch(`${server.origin}${untrustedPath}`);
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.equal(body, 'Not found\n');
  assert.ok(body.length < 100);
});
