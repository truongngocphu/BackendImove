const dgram = require('dgram');
const os = require('os');
const { version: PACKAGE_VERSION } = require('../package.json');
const APP_VERSION = String(process.env.APP_VERSION || PACKAGE_VERSION || '1.6.0').trim();

const DISCOVERY_MAGIC = 'TH79_IMOVE_DISCOVER_V2';
const SERVICE_NAME = 'TH79_IMOVE_CORE';
const SERVICE_REGISTRY_KEY = 'TH79_IMOVE_CORE_V1';

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => (((acc << 8) >>> 0) + Number(part)) >>> 0, 0) >>> 0;
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function broadcastAddress(address, netmask) {
  try {
    const ip = ipToInt(address);
    const mask = ipToInt(netmask);
    return intToIp((ip | (~mask >>> 0)) >>> 0);
  } catch (_) {
    return null;
  }
}

function getLanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();

  for (const [name, items] of Object.entries(interfaces)) {
    for (const item of items || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const address = item.address;
      const netmask = item.netmask || '255.255.255.0';
      result.push({
        interface: name,
        address,
        netmask,
        broadcast: broadcastAddress(address, netmask),
        cidr: item.cidr || null,
      });
    }
  }

  return result;
}

function startLanDiscovery({ httpPort, discoveryPort = 5051 }) {
  const production = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production';
  const defaultEnabled = production ? 'false' : 'true';
  const enabled = String(process.env.LAN_DISCOVERY_ENABLED ?? defaultEnabled).toLowerCase() === 'true';

  if (!enabled) return { close() {} };

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (error) => {
    console.error('[LAN Discovery] UDP error:', error.message);
  });

  socket.on('message', (message, rinfo) => {
    const text = message.toString('utf8').trim();
    if (![DISCOVERY_MAGIC, 'TH79_IMOVE_DISCOVER_V1'].includes(text)) return;

    const payload = Buffer.from(JSON.stringify({
      service: SERVICE_NAME,
      discoveryMagic: DISCOVERY_MAGIC,
      version: APP_VERSION,
      port: Number(httpPort),
      database: process.env.MONGODB_DB || 'th79_imove',
      hostname: os.hostname(),
      addresses: getLanAddresses(),
      timestamp: Date.now(),
    }));

    socket.send(payload, rinfo.port, rinfo.address, (error) => {
      if (error) console.error('[LAN Discovery] Reply failed:', error.message);
    });
  });

  socket.bind(Number(discoveryPort), '0.0.0.0', () => {
    try { socket.setBroadcast(true); } catch (_) {}
    console.log(`[LAN Discovery] READY UDP 0.0.0.0:${discoveryPort}`);
  });

  return {
    close() {
      try { socket.close(); } catch (_) {}
    },
  };
}

function startServiceRegistry({ getDb, httpPort, discoveryPort = 5051 }) {
  const production = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production';
  const defaultEnabled = production ? 'false' : 'true';
  const enabled = String(process.env.SERVICE_REGISTRY_ENABLED ?? defaultEnabled).toLowerCase() === 'true';
  if (!enabled) return { async refresh() {}, close() {} };

  const intervalMs = Math.max(3000, Number(process.env.SERVICE_REGISTRY_HEARTBEAT_MS || 5000));
  const ttlSeconds = Math.max(30, Number(process.env.SERVICE_REGISTRY_TTL_SECONDS || 90));
  const instanceId = `${os.hostname()}-${process.pid}`;
  let timer = null;
  let stopped = false;
  let indexReady = false;

  async function heartbeat() {
    if (stopped) return;
    const db = getDb();
    if (!db) return;

    try {
      const col = db.collection('service_registry');
      if (!indexReady) {
        try {
          await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'service_registry_ttl' });
          await col.createIndex({ service: 1, lastSeenAt: -1 }, { name: 'service_registry_service_seen' });
        } catch (_) {}
        indexReady = true;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      const publicUrl = String(process.env.CORE_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;

      await col.updateOne(
        { serviceKey: SERVICE_REGISTRY_KEY, instanceId },
        {
          $set: {
            serviceKey: SERVICE_REGISTRY_KEY,
            service: SERVICE_NAME,
            instanceId,
            hostname: os.hostname(),
            version: APP_VERSION,
            databaseName: process.env.MONGODB_DB || 'th79_imove',
            httpPort: Number(httpPort),
            discoveryPort: Number(discoveryPort),
            addresses: getLanAddresses(),
            publicUrl,
            lastSeenAt: now,
            expiresAt,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );
    } catch (error) {
      console.warn('[Service Registry] heartbeat failed:', error.message);
    }
  }

  heartbeat();
  timer = setInterval(heartbeat, intervalMs);
  timer.unref?.();

  return {
    async refresh() { await heartbeat(); },
    close() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = {
  DISCOVERY_MAGIC,
  SERVICE_NAME,
  SERVICE_REGISTRY_KEY,
  broadcastAddress,
  getLanAddresses,
  startLanDiscovery,
  startServiceRegistry,
};
