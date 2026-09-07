import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';

function unwrap(value) { return value?.data ?? value; }
function normalizeMac(value) { return typeof value === 'string' ? value.trim().toLowerCase().replaceAll('-', ':') : ''; }

function requestJson(target, headers, timeoutMs, ca) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET', headers, timeout: timeoutMs,
      ...(url.protocol === 'https:' ? { ca } : {}),
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 500) >= 400) return reject(new Error(`UniFi API returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('UniFi API returned invalid JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('UniFi API request timed out')));
    request.on('error', reject);
    request.end();
  });
}

export function createUniFiLookup({ baseUrl, apiKey, clientsPath, timeoutMs = 5000, caCertPath }) {
  if (!baseUrl || !apiKey) return async () => new Map();
  const ca = caCertPath && existsSync(caCertPath) ? readFileSync(caCertPath) : undefined;
  return async function lookupUniFi() {
    const controller = baseUrl.replace(/\/$/u, '');
    const headers = { accept: 'application/json', 'X-API-KEY': apiKey };
    let clients = unwrap(await requestJson(`${controller}${clientsPath || '/sites'}`, headers, timeoutMs, ca));
    if (!clientsPath) {
      const sites = Array.isArray(clients) ? clients : clients?.data;
      const siteId = sites?.[0]?.id;
      if (!siteId) return new Map();
      clients = unwrap(await requestJson(`${controller}/sites/${encodeURIComponent(siteId)}/clients`, headers, timeoutMs, ca));
    }
    const list = Array.isArray(clients) ? clients : clients?.data;
    return new Map((Array.isArray(list) ? list : []).flatMap(client => {
      const mac = normalizeMac(client.mac ?? client.macAddress);
      return mac ? [[mac, client]] : [];
    }));
  };
}
