require('dotenv').config();
const { MongoClient } = require('mongodb');

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  const dbName = String(process.env.MONGODB_DB || 'th79_imove').trim();
  if (!uri) throw new Error('Thiếu MONGODB_URI trong .env');

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(dbName);

  const specs = [
    ['bookings', { createdAt: -1 }, 'analytics_createdAt_desc'],
    ['orders', { createdAt: -1 }, 'analytics_createdAt_desc'],
    ['payments', { createdAt: -1 }, 'analytics_createdAt_desc'],
  ];

  for (const [collection, key, name] of specs) {
    try {
      const result = await db.collection(collection).createIndex(key, { name });
      console.log(`[OK] ${collection}: ${result}`);
    } catch (error) {
      if (error?.codeName === 'NamespaceNotFound') {
        console.log(`[SKIP] ${collection}: collection chưa tồn tại`);
      } else {
        throw error;
      }
    }
  }

  await client.close();
  console.log('Analytics indexes READY.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
