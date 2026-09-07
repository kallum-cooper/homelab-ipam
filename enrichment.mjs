function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function enrichEntries(entries, { lookupUniFi, reverseDns }) {
  let clients = new Map();
  try { clients = await lookupUniFi(); } catch { clients = new Map(); }
  return Promise.all(entries.map(async entry => {
    const client = entry.mac ? clients.get(entry.mac.toLowerCase()) : undefined;
    const hostname = clean(client?.name) || clean(client?.hostname);
    if (hostname) return { ...entry, hostname };
    try {
      const resolved = clean(await reverseDns(entry.ip));
      return resolved ? { ...entry, hostname: resolved } : entry;
    } catch { return entry; }
  }));
}
