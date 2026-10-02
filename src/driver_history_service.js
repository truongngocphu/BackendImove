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
    // Prefer the immutable driver-net snapshot written at booking/completion time.
    // Older rows may not have customerTotal, so calculating customerTotal-fee alone
    // incorrectly showed 0 income in Driver history.
    const driverNetSnapshot = n(
      row.fareSnapshot?.driverNetAmount ??
      row.pricing?.driverNetAmount ??
      row.fareSnapshot?.driverEarningAmount ??
      row.pricing?.driverEarningAmount,
      NaN,
    );
    const driverNetExpected = Number.isFinite(driverNetSnapshot)
      ? Math.max(0, driverNetSnapshot)
      : Math.max(0, customerTotal - fee);
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
      driverNetExpected,
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
  // /earnings already queries COMPLETED bookings, but accepting rows without a
  // status keeps this helper compatible with normalized/legacy callers.
  const completed = rows.filter((x) => !x.status || String(x.status).toUpperCase() === 'COMPLETED');
  const cashCollected = completed.reduce((s, x) => s + n(x.cashCollected), 0);
  const platformFee = completed.reduce((s, x) => s + n(x.platformFee), 0);
  const platformFeePointsTotal = completed.reduce((s, x) => s + n(x.platformFeePoints), 0);
  const expectedNet = completed.reduce((s, x) => s + n(x.driverNetExpected), 0);
  const postedAmount = completed.reduce((s, x) => s + n(x.postedAmount), 0);
  const pendingAmount = completed.reduce((s, x) => {
    const expected = Math.max(0, n(x.driverNetExpected));
    const posted = Math.max(0, n(x.postedAmount));
    return s + Math.max(0, expected - posted);
  }, 0);
  const netAfterPlatformFee = Math.max(0, cashCollected - platformFee);
  return {
    cashCollected,
    platformFee,
    platformFeePoints: platformFeePointsTotal,
    netAfterPlatformFee,
    completedTrips: completed.length,
    expectedNet,
    postedAmount,
    pendingAmount,
  };
}
module.exports = {
  normalizeDriverTripHistory,
  settlementLabel,
  summarizeDriverEarnings,
};
