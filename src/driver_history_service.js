const { platformFeeVnd, platformFeePoints } = require('./driver_points_service');

function n(v, f = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : f;
}
function settlementLabel(row) {
  const raw = String(
    row?.settlementV140?.status ||
    row?.settlementV133?.status ||
    row?.settlementV73?.status ||
    'PENDING',
  ).toUpperCase();
  if (['SETTLED', 'POSTED', 'COMPLETED'].includes(raw)) return 'SETTLED';
  if (['FAILED', 'PARTIAL', 'RECONCILE_REQUIRED'].includes(raw)) return 'RECONCILE_REQUIRED';
  return 'PROCESSING';
}
function paymentMethod(row) {
  return String(row?.paymentMethod || row?.payment?.method || row?.pricing?.paymentMethod || 'CASH').toUpperCase();
}
function normalizeDriverTripHistory(rows = []) {
  return rows.map((row) => {
    const customerTotal = n(
      row.fareSnapshot?.customerTotal ??
      row.pricing?.customerTotal ??
      row.pricing?.total,
    );
    const fee = platformFeeVnd(row);
    const feePoints = platformFeePoints(row);
    return {
      id: String(row._id || row.id || ''),
      code: row.bookingCode || row.code || '',
      status: String(row.status || '').toUpperCase(),
      serviceCode: String(row.serviceCode || 'BIKE').toUpperCase(),
      completedAt: row.completedAt || null,
      paymentMethod: paymentMethod(row),
      customerTotal,
      cashCollected: paymentMethod(row) === 'CASH' ? customerTotal : 0,
      platformFee: fee,
      platformFeePoints: feePoints,
      driverNetExpected: Math.max(0, customerTotal - fee),
      postedAmount: n(
        row.settlementV140?.driverEarning?.amount ??
        row.settlementV133?.driverEarning?.amount,
        0,
      ),
      settlementStatus: settlementLabel(row),
      pickup: row.pickup?.address || '',
      destination: row.destination?.address || '',
    };
  });
}
function summarizeDriverEarnings(rows = []) {
  const completed = rows.filter((x) => x.status === 'COMPLETED');
  const cashCollected = completed.reduce((s, x) => s + n(x.cashCollected), 0);
  const platformFee = completed.reduce((s, x) => s + n(x.platformFee), 0);
  const platformFeePointsTotal = completed.reduce((s, x) => s + n(x.platformFeePoints), 0);
  const netAfterPlatformFee = Math.max(0, cashCollected - platformFee);
  return {
    cashCollected,
    platformFee,
    platformFeePoints: platformFeePointsTotal,
    netAfterPlatformFee,
    completedTrips: completed.length,
    // compatibility fields for older clients
    expectedNet: completed.reduce((s, x) => s + n(x.driverNetExpected), 0),
    postedAmount: completed.reduce((s, x) => s + n(x.postedAmount), 0),
    pendingAmount: 0,
  };
}
module.exports = {
  normalizeDriverTripHistory,
  settlementLabel,
  summarizeDriverEarnings,
};
