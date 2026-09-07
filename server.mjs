import { readFile } from 'node:fs/promises';

const DEFAULT_INDEX_PATH = new URL('./index.html', import.meta.url);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createRequestHandler({
  manager,
  store,
  indexPath = DEFAULT_INDEX_PATH,
}) {
  if (!manager || typeof manager.scan !== 'function' || typeof manager.getStatus !== 'function') {
    throw new TypeError('manager is required');
  }
  if (!store || typeof store.load !== 'function') throw new TypeError('store is required');

  function sendJson(response, value) {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(`${JSON.stringify(value)}\n`);
  }

  function currentStatus() {
    return manager.getStatus();
  }

  async function scan() {
    try {
      return await manager.scan();
    } catch (error) {
      return {
        ...currentStatus(),
        ok: false,
        scanInProgress: false,
        error: errorMessage(error),
      };
    }
  }

  return async function requestHandler(request, response) {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    if (request.method === 'GET' && pathname === '/api/status') {
      sendJson(response, currentStatus());
      return;
    }

    if (request.method === 'POST' && pathname === '/api/scan') {
      sendJson(response, await scan());
      return;
    }

    if (request.method === 'GET' && pathname === '/') {
      try {
        const page = await readFile(indexPath);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page);
      } catch {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Unable to load index.html\n');
      }
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found\n');
  };
}
