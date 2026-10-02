'use strict';
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const uri = String(process.env.MONGODB_URI || '').trim();
  const dbName = String(process.env.MONGODB_DB || 'th79_imove').trim();
  if (!uri) throw new Error('Thiếu MONGODB_URI.');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const now = new Date();
    const patch = {
      matchingEnabled: true,
      offerTimeoutSeconds: 20,
      searchRetrySeconds: 5,
      maxRadiusKm: 8,
      locationFreshSeconds: 60,
      maxCandidates: 50,
    };
    await db.collection('app_settings').updateOne(
      { key: 'MATCHING_POLICY' },
      { $set: { key: 'MATCHING_POLICY', status: 'ACTIVE', 'value.fastMode': patch, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    console.log('[MATCHING] Đã áp dụng cấu hình fastMode an toàn:', patch);
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error('[MATCHING] Không thể áp dụng fastMode:', error.message);
  process.exit(1);
});
