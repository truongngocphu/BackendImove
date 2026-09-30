require('dotenv').config();
const { MongoClient } = require('mongodb');

const FAST_DISPATCH = {
  enabled: true,
  maxRounds: 4,
  rounds: [
    { round: 1, candidateCount: 5, radiusKm: 3, timeoutSeconds: 7 },
    { round: 2, candidateCount: 8, radiusKm: 5, timeoutSeconds: 7 },
    { round: 3, candidateCount: 12, radiusKm: 8, timeoutSeconds: 8 },
    { round: 4, candidateCount: 20, radiusKm: 12, timeoutSeconds: 10 },
  ],
  cooldown: { declineSeconds: 30, timeoutSeconds: 10, sameBookingSeconds: 180 },
  retry: { maxDispatchRetries: 3, retryDelaySeconds: [1, 2, 5] },
};

const FAST_MATCHING = {
  autoDispatchEnabled: true,
  offerTimeoutSeconds: 8,
  searchRetrySeconds: 2,
  maxRadiusKm: 12,
  locationFreshSeconds: 90,
  maxCandidates: 100,
  // Không bật no-GPS fallback trong production để tránh phát cuốc sai vị trí.
  allowNoGpsFallback: false,
};

(async () => {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('Thiếu MONGODB_URI trong .env');
  const dbName = String(process.env.MONGODB_DB || 'th79_imove').trim();
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const now = new Date();

  await db.collection('dispatch_configs').updateOne(
    { key: 'BIKE_V69_DISPATCH' },
    {
      $set: { ...FAST_DISPATCH, updatedAt: now, source: 'FAST_MATCHING_1_6_0' },
      $setOnInsert: { key: 'BIKE_V69_DISPATCH', createdAt: now },
    },
    { upsert: true },
  );

  const current = await db.collection('matching_policies').findOne({ key: 'BIKE_MATCHING_POLICY' });
  await db.collection('matching_policies').updateOne(
    { key: 'BIKE_MATCHING_POLICY' },
    {
      $set: {
        ...FAST_MATCHING,
        status: 'ACTIVE',
        version: Number(current?.version || 1) + 1,
        updatedAt: now,
        source: 'FAST_MATCHING_1_6_0',
      },
      $setOnInsert: { key: 'BIKE_MATCHING_POLICY', createdAt: now },
    },
    { upsert: true },
  );

  const dispatch = await db.collection('dispatch_configs').findOne({ key: 'BIKE_V69_DISPATCH' });
  const matching = await db.collection('matching_policies').findOne({ key: 'BIKE_MATCHING_POLICY' });
  console.log(JSON.stringify({ ok: true, dispatch, matching }, null, 2));
  await client.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
