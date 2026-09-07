import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createScanManager } from './scan-manager.mjs';
import { scanNetwork } from './scanner.mjs';
import { createRequestHandler } from './server.mjs';
import { createStateStore } from './state.mjs';
import { enrichEntries } from './enrichment.mjs';
import { createUniFiLookup } from './unifi.mjs';
import { promises as dns } from 'node:dns';

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function scanArguments(value) {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(argument => typeof argument !== 'string')) {
    throw new TypeError('IPAM_SCAN_ARGS_JSON must be a JSON array of strings');
  }
  return parsed;
}

export function configurationFromEnv(env = process.env) {
  const port = positiveInteger(env.IPAM_PORT ?? '8787', 'IPAM_PORT');
  if (port > 65_535) throw new RangeError('IPAM_PORT must not exceed 65535');

  return {
    port,
    host: env.IPAM_HOST ?? '0.0.0.0',
    dataPath: env.IPAM_DATA_PATH ?? '/data/ipam-state.json',
    scanCommand: env.IPAM_SCAN_COMMAND ?? 'arp-scan',
    scanArgs: scanArguments(env.IPAM_SCAN_ARGS_JSON ?? '[]'),
    scanTimeoutMs: positiveInteger(env.IPAM_SCAN_TIMEOUT_MS ?? '30000', 'IPAM_SCAN_TIMEOUT_MS'),
    unifiBaseUrl: env.UNIFI_BASE_URL ?? '',
    unifiApiKey: env.UNIFI_API_KEY ?? '',
    unifiClientsPath: env.UNIFI_CLIENTS_PATH ?? '',
    unifiCaCertPath: env.UNIFI_CA_CERT_PATH ?? '/run/secrets/unifi-ca.pem',
  };
}

export async function startService(configuration = configurationFromEnv()) {
  const store = createStateStore(configuration.dataPath);
  const manager = createScanManager({
    scanner: () => scanNetwork({
      command: configuration.scanCommand,
      args: configuration.scanArgs,
      timeoutMs: configuration.scanTimeoutMs,
    }).then(entries => enrichEntries(entries, {
      lookupUniFi: createUniFiLookup({
        baseUrl: configuration.unifiBaseUrl,
        apiKey: configuration.unifiApiKey,
        clientsPath: configuration.unifiClientsPath,
        caCertPath: configuration.unifiCaCertPath,
      }),
      reverseDns: ip => dns.reverse(ip).then(names => names[0]),
    })),
    store,
  });
  await manager.start();
  const server = createServer(createRequestHandler({ manager, store }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(configuration.port, configuration.host, resolve);
  });

  const stop = () => {
    manager.stop();
    server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}

const isMain = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  startService().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
