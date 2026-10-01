const { ObjectId } = require('mongodb');

const POLICY_KEY = 'BIKE_MATCHING_POLICY';

const DEFAULT_MATCHING_POLICY = Object.freeze({
  key: POLICY_KEY,
  version: 1,
  status: 'ACTIVE',
  strategy: 'BALANCED',
  autoDispatchEnabled: true,
  offerTimeoutSeconds: 8,
  searchRetrySeconds: 2,
  maxRadiusKm: 12,
  locationFreshSeconds: 90,
  maxCandidates: 100,
  dispatchRounds: [
    { radiusKm: 2, maxCandidates: 5, offerTimeoutSeconds: 6 },
    { radiusKm: 4, maxCandidates: 8, offerTimeoutSeconds: 7 },
    { radiusKm: 8, maxCandidates: 12, offerTimeoutSeconds: 8 },
    { radiusKm: 12, maxCandidates: 16, offerTimeoutSeconds: 10 },
  ],
  allowNoGpsFallback: false,
  pointsPolicy: {
    blockBelow: 0,
    warnBelow: 20,
  },
  filters: {
    minRating: 0,
    minAcceptanceRate: 0,
    maxTrips24h: 0,
  },
  weights: {
    distance: 35,
    rating: 20,
    acceptance: 15,
    lowTrips: 15,
    idleTime: 10,
    driverPoints: 5,
  },
  fairness: {
    recentTripsWindowHours: 24,
    idleCapMinutes: 360,
  },
});

const PRESETS = Object.freeze({
  BALANCED: {
    strategy: 'BALANCED',
    weights: { distance: 35, rating: 20, acceptance: 15, lowTrips: 15, idleTime: 10, driverPoints: 5 },
  },
  NEAREST: {
    strategy: 'NEAREST',
    weights: { distance: 70, rating: 10, acceptance: 8, lowTrips: 5, idleTime: 5, driverPoints: 2 },
  },
  QUALITY: {
    strategy: 'QUALITY',
    weights: { distance: 15, rating: 45, acceptance: 25, lowTrips: 5, idleTime: 3, driverPoints: 7 },
  },
  FAIRNESS: {
    strategy: 'FAIRNESS',
    weights: { distance: 20, rating: 8, acceptance: 7, lowTrips: 40, idleTime: 20, driverPoints: 5 },
  },
  FIVE_STAR: {
    strategy: 'FIVE_STAR',
    weights: { distance: 15, rating: 60, acceptance: 15, lowTrips: 3, idleTime: 2, driverPoints: 5 },
  },
  POINTS: {
    strategy: 'POINTS',
    weights: { distance: 15, rating: 10, acceptance: 10, lowTrips: 5, idleTime: 5, driverPoints: 55 },
  },
});

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

function boolValue(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}


function normalizeDispatchRounds(raw, defaults = DEFAULT_MATCHING_POLICY.dispatchRounds) {
  const input = Array.isArray(raw) && raw.length ? raw : defaults;
  const rows = input.slice(0, 4).map((round, index) => {
    const fallback = defaults[Math.min(index, defaults.length - 1)] || defaults[defaults.length - 1];
    return {
      radiusKm: clampNumber(round?.radiusKm, fallback.radiusKm, 0.5, 100),
      maxCandidates: clampInt(round?.maxCandidates, fallback.maxCandidates, 1, 200),
      offerTimeoutSeconds: clampInt(round?.offerTimeoutSeconds, fallback.offerTimeoutSeconds, 3, 120),
    };
  });
  while (rows.length < 4) {
    const fallback = defaults[Math.min(rows.length, defaults.length - 1)] || defaults[defaults.length - 1];
    rows.push({ ...fallback });
  }
  // Round sau không được nhỏ hơn Round trước về bán kính.
  for (let i = 1; i < rows.length; i += 1) {
    rows[i].radiusKm = Math.max(rows[i - 1].radiusKm, rows[i].radiusKm);
  }
  return rows;
}

function normalizeWeights(raw = {}) {
  const defaults = DEFAULT_MATCHING_POLICY.weights;
  return {
    distance: clampNumber(raw.distance, defaults.distance, 0, 100),
    rating: clampNumber(raw.rating, defaults.rating, 0, 100),
    acceptance: clampNumber(raw.acceptance, defaults.acceptance, 0, 100),
    lowTrips: clampNumber(raw.lowTrips, defaults.lowTrips, 0, 100),
    idleTime: clampNumber(raw.idleTime, defaults.idleTime, 0, 100),
    driverPoints: clampNumber(raw.driverPoints, defaults.driverPoints, 0, 100),
  };
}

function normalizeMatchingPolicy(raw = {}, runtimeDefaults = {}) {
  const defaults = {
    ...DEFAULT_MATCHING_POLICY,
    ...runtimeDefaults,
    filters: { ...DEFAULT_MATCHING_POLICY.filters, ...(runtimeDefaults.filters || {}) },
    weights: { ...DEFAULT_MATCHING_POLICY.weights, ...(runtimeDefaults.weights || {}) },
    fairness: { ...DEFAULT_MATCHING_POLICY.fairness, ...(runtimeDefaults.fairness || {}) },
    pointsPolicy: { ...DEFAULT_MATCHING_POLICY.pointsPolicy, ...(runtimeDefaults.pointsPolicy || {}) },
    dispatchRounds: normalizeDispatchRounds(runtimeDefaults.dispatchRounds, DEFAULT_MATCHING_POLICY.dispatchRounds),
  };

  const strategy = String(raw.strategy || defaults.strategy || 'BALANCED').trim().toUpperCase();
  const preset = PRESETS[strategy] || null;
  const selectedWeights = raw.weights || preset?.weights || defaults.weights;

  const pointBlockBelow = clampNumber(
    raw.pointsPolicy?.blockBelow,
    defaults.pointsPolicy.blockBelow,
    0,
    1000000,
  );
  const pointWarnBelow = Math.max(
    pointBlockBelow,
    clampNumber(
      raw.pointsPolicy?.warnBelow,
      defaults.pointsPolicy.warnBelow,
      0,
      1000000,
    ),
  );

  const dispatchRounds = normalizeDispatchRounds(raw.dispatchRounds, defaults.dispatchRounds);
  const roundMaxRadius = Math.max(...dispatchRounds.map((round) => round.radiusKm));

  return {
    key: POLICY_KEY,
    version: clampInt(raw.version, defaults.version || 1, 1, 999999),
    status: String(raw.status || defaults.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    strategy: PRESETS[strategy] ? strategy : 'CUSTOM',
    autoDispatchEnabled: boolValue(raw.autoDispatchEnabled, defaults.autoDispatchEnabled),
    offerTimeoutSeconds: clampInt(raw.offerTimeoutSeconds, defaults.offerTimeoutSeconds, 5, 120),
    searchRetrySeconds: clampInt(raw.searchRetrySeconds, defaults.searchRetrySeconds, 2, 60),
    maxRadiusKm: Math.max(roundMaxRadius, clampNumber(raw.maxRadiusKm, defaults.maxRadiusKm, 0.5, 100)),
    dispatchRounds,
    locationFreshSeconds: clampInt(raw.locationFreshSeconds, defaults.locationFreshSeconds, 10, 300),
    maxCandidates: clampInt(raw.maxCandidates, defaults.maxCandidates, 5, 200),
    allowNoGpsFallback: boolValue(raw.allowNoGpsFallback, defaults.allowNoGpsFallback),
    pointsPolicy: {
      blockBelow: pointBlockBelow,
      warnBelow: pointWarnBelow,
    },
    filters: {
      minRating: clampNumber(raw.filters?.minRating, defaults.filters.minRating, 0, 5),
      minAcceptanceRate: clampNumber(raw.filters?.minAcceptanceRate, defaults.filters.minAcceptanceRate, 0, 100),
      maxTrips24h: clampInt(raw.filters?.maxTrips24h, defaults.filters.maxTrips24h, 0, 100),
    },
    weights: normalizeWeights(selectedWeights),
    fairness: {
      recentTripsWindowHours: clampInt(raw.fairness?.recentTripsWindowHours, defaults.fairness.recentTripsWindowHours, 1, 168),
      idleCapMinutes: clampInt(raw.fairness?.idleCapMinutes, defaults.fairness.idleCapMinutes, 30, 1440),
    },
  };
}

function getDriverPoints(driver = {}) {
  const values = [
    driver.performancePoints,
    driver.driverPoints,
    driver.rewardPoints,
    driver.points,
  ];
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  // Điểm hiệu suất mặc định 0-100 khi hệ thống chưa có trường điểm riêng.
  // Công thức chỉ dùng dữ liệu vận hành đã có: rating, acceptanceRate, completedTrips.
  const rating = Math.max(0, Math.min(5, Number(driver.rating || 0)));
  const acceptance = Math.max(0, Math.min(100, Number(driver.acceptanceRate || 0)));
  const trips = Math.max(0, Number(driver.completedTrips || 0));
  return Number((rating / 5 * 60 + acceptance / 100 * 30 + Math.min(1, trips / 500) * 10).toFixed(2));
}

function safeObjectId(value) {
  try { return value instanceof ObjectId ? value : new ObjectId(String(value)); } catch (_) { return null; }
}


async function loadPointBalances(db, driverIds) {
  if (!driverIds.length) return new Map();
  const rows = await db.collection('driver_reward_accounts')
    .find({ driverId: { $in: driverIds } })
    .project({ driverId: 1, balance: 1 })
    .toArray();
  return new Map(rows.map((row) => [String(row.driverId), Number(row.balance || 0)]));
}

async function loadRecentTripStats(db, driverIds, policy) {
  if (!driverIds.length) return new Map();
  const cutoff = new Date(Date.now() - policy.fairness.recentTripsWindowHours * 3600 * 1000);
  const rows = await db.collection('bookings').aggregate([
    {
      $match: {
        driverId: { $in: driverIds },
        status: 'COMPLETED',
        completedAt: { $gte: cutoff },
      },
    },
    {
      $group: {
        _id: '$driverId',
        trips: { $sum: 1 },
        lastCompletedAt: { $max: '$completedAt' },
      },
    },
  ]).toArray();

  const map = new Map();
  for (const row of rows) {
    map.set(String(row._id), {
      trips: Number(row.trips || 0),
      lastCompletedAt: row.lastCompletedAt || null,
    });
  }
  return map;
}

function normalizeScoreParts(candidate, policy, maxima) {
  const driver = candidate.driver || {};
  const distance = Number(candidate.distanceKm);
  const distanceScore = Number.isFinite(distance)
    ? Math.max(0, 100 * (1 - Math.min(distance, policy.maxRadiusKm) / policy.maxRadiusKm))
    : 0;

  const rating = Math.max(0, Math.min(5, Number(driver.rating || 0)));
  const ratingScore = Math.max(0, Math.min(100, ((rating - 1) / 4) * 100));
  const acceptanceScore = Math.max(0, Math.min(100, Number(driver.acceptanceRate || 0)));

  const recentTrips = Number(candidate.recentTrips || 0);
  const maxRecentTrips = Math.max(1, Number(maxima.maxRecentTrips || 1));
  const lowTripsScore = Math.max(0, 100 * (1 - recentTrips / maxRecentTrips));

  const lastCompletedAt = candidate.lastCompletedAt ? new Date(candidate.lastCompletedAt) : null;
  const idleMinutes = lastCompletedAt && Number.isFinite(lastCompletedAt.getTime())
    ? Math.max(0, (Date.now() - lastCompletedAt.getTime()) / 60000)
    : policy.fairness.idleCapMinutes;
  const idleScore = Math.max(0, Math.min(100, (idleMinutes / policy.fairness.idleCapMinutes) * 100));

  const points = Number(candidate.driverPoints || 0);
  const pointsScore = maxima.maxPoints > 0
    ? Math.max(0, Math.min(100, (points / maxima.maxPoints) * 100))
    : 0;

  return {
    distance: Number(distanceScore.toFixed(2)),
    rating: Number(ratingScore.toFixed(2)),
    acceptance: Number(acceptanceScore.toFixed(2)),
    lowTrips: Number(lowTripsScore.toFixed(2)),
    idleTime: Number(idleScore.toFixed(2)),
    driverPoints: Number(pointsScore.toFixed(2)),
  };
}

async function rankMatchingCandidates({ db, candidates, policy }) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const driverIds = candidates.map((c) => safeObjectId(c.driver?._id)).filter(Boolean);
  const [recentStats, pointBalances] = await Promise.all([
    loadRecentTripStats(db, driverIds, policy),
    loadPointBalances(db, driverIds),
  ]);

  const enriched = candidates.map((candidate) => {
    const stats = recentStats.get(String(candidate.driver?._id)) || { trips: 0, lastCompletedAt: null };
    const pointBalance = Number(pointBalances.get(String(candidate.driver?._id)) ?? 0);
    const pointsBlocked = pointBalance < Number(policy.pointsPolicy?.blockBelow ?? 0);
    const pointsLow = !pointsBlocked && pointBalance <= Number(policy.pointsPolicy?.warnBelow ?? 20);
    return {
      ...candidate,
      recentTrips: stats.trips,
      lastCompletedAt: stats.lastCompletedAt,
      driverPoints: getDriverPoints(candidate.driver),
      pointBalance,
      pointsBlocked,
      pointsLow,
      pointStatus: pointsBlocked ? 'BLOCKED' : (pointsLow ? 'LOW' : 'OK'),
      pointWarning: pointsBlocked
        ? `Số dư điểm ${pointBalance}. Tài xế phải nạp điểm trước khi nhận cuốc.`
        : (pointsLow ? `Số dư điểm còn ${pointBalance}. Nên nạp thêm điểm.` : null),
    };
  }).filter((candidate) => {
    const rating = Number(candidate.driver?.rating || 0);
    const acceptance = Number(candidate.driver?.acceptanceRate || 0);
    if (policy.filters.minRating > 0 && rating < policy.filters.minRating) return false;
    if (policy.filters.minAcceptanceRate > 0 && acceptance < policy.filters.minAcceptanceRate) return false;
    if (policy.filters.maxTrips24h > 0 && candidate.recentTrips >= policy.filters.maxTrips24h) return false;
    return true;
  });

  const maxima = {
    maxRecentTrips: Math.max(1, ...enriched.map((c) => Number(c.recentTrips || 0))),
    maxPoints: Math.max(0, ...enriched.map((c) => Number(c.driverPoints || 0))),
  };

  const weightSum = Object.values(policy.weights).reduce((sum, value) => sum + Number(value || 0), 0) || 1;

  return enriched.map((candidate) => {
    const parts = normalizeScoreParts(candidate, policy, maxima);
    let score = 0;
    for (const [key, weight] of Object.entries(policy.weights)) {
      score += Number(parts[key] || 0) * Number(weight || 0);
    }
    score /= weightSum;

    const priority = Number(candidate.driver?.matchingPriority || 0);
    const priorityUntil = candidate.driver?.matchingPriorityUntil
      ? new Date(candidate.driver.matchingPriorityUntil)
      : null;
    const activePriority = Number.isFinite(priority)
      && priority !== 0
      && (!priorityUntil || priorityUntil.getTime() > Date.now());
    const manualBoost = activePriority ? Math.max(-30, Math.min(30, priority * 3)) : 0;
    score += manualBoost;

    return {
      ...candidate,
      matchingScore: Number(Math.max(0, Math.min(130, score)).toFixed(2)),
      matchingBreakdown: parts,
      matchingManualBoost: manualBoost,
      matchingPriority: activePriority ? priority : 0,
    };
  }).sort((a, b) => {
    if (b.matchingScore !== a.matchingScore) return b.matchingScore - a.matchingScore;
    const da = Number.isFinite(Number(a.distanceKm)) ? Number(a.distanceKm) : Infinity;
    const dbb = Number.isFinite(Number(b.distanceKm)) ? Number(b.distanceKm) : Infinity;
    if (da !== dbb) return da - dbb;
    return Number(b.driver?.rating || 0) - Number(a.driver?.rating || 0);
  }).map((candidate, index) => ({ ...candidate, matchingRank: index + 1 }));
}

module.exports = {
  POLICY_KEY,
  DEFAULT_MATCHING_POLICY,
  MATCHING_PRESETS: PRESETS,
  normalizeMatchingPolicy,
  rankMatchingCandidates,
  getDriverPoints,
};
