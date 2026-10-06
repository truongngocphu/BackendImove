function n(v, f = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : f;
}

function normalizePaymentStatus(v) {
  const s = String(v || 'UNPAID').toUpperCase();
  if (['PAID', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'SETTLED'].includes(s)) return 'PAID';
  if (['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(s)) return 'FAILED';
  if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(s)) return 'REFUNDED';
  return 'PENDING';
}

function serviceLabel(row, catalog = new Map()) {
  const code = String(row?.serviceCode || row?.service || '').trim().toUpperCase();
  if (!code) return 'Không xác định';
  return catalog.get(code)?.name || code;
}

function normalizeAnalyticsTrip(row, catalog = new Map()) {
  const status = String(row?.status || '').toUpperCase();
  let paymentStatus = normalizePaymentStatus(row?.paymentStatus);

  if (status === 'COMPLETED' && String(row?.paymentMethod || 'CASH').toUpperCase() === 'CASH') {
    paymentStatus = 'PAID';
  }

  const customerTotal = n(
    row?.fareSnapshot?.customerTotal ??
      row?.pricing?.customerTotal ??
      row?.pricing?.total,
  );
  const driverNet = n(
    row?.fareSnapshot?.driverNetAmount ??
      row?.pricing?.driverNetAmount,
  );
  const platformRevenue = n(
    row?.fareSnapshot?.platformRevenueEstimate ??
      row?.pricing?.platformRevenueEstimate ??
      row?.pricing?.platformCommission,
  );

  return {
    id: String(row?._id || row?.id || ''),
    serviceCode: String(row?.serviceCode || row?.service || 'BIKE').toUpperCase(),
    serviceName: serviceLabel(row, catalog),
    status,
    completed: status === 'COMPLETED',
    cancelled: ['CANCELLED', 'CANCELLED_BY_USER', 'CANCELLED_BY_DRIVER', 'EXPIRED'].includes(status),
    paymentStatus,
    paymentSuccessful: paymentStatus === 'PAID',
    customerTotal,
    driverNet,
    platformRevenue,
    createdAt: row?.createdAt || null,
    completedAt: row?.completedAt || null,
    rating: n(row?.rating ?? row?.driverRating, 0),
    settlementStatus: String(
      row?.settlementV140?.status || row?.settlementV133?.status || 'PENDING',
    ).toUpperCase(),
  };
}

function derivedPayment(row, source) {
  const status = String(row?.status || '').toUpperCase();
  const method = String(row?.paymentMethod || 'CASH').toUpperCase();
  const done = source === 'BOOKING'
    ? status === 'COMPLETED'
    : ['COMPLETED', 'DELIVERED'].includes(status);
  const cancelled = ['CANCELLED', 'CANCELLED_BY_USER', 'CANCELLED_BY_DRIVER', 'EXPIRED'].includes(status);

  let p = normalizePaymentStatus(row?.paymentStatus);
  if (done && method === 'CASH') p = 'PAID';
  else if (cancelled && p === 'PENDING') p = 'FAILED';

  const amount = source === 'BOOKING'
    ? n(row?.fareSnapshot?.customerTotal ?? row?.pricing?.customerTotal ?? row?.pricing?.total)
    : n(row?.total);

  return {
    id: `${source}:${String(row?._id || '')}`,
    referenceId: String(row?._id || ''),
    referenceCode: row?.bookingCode || row?.orderCode || '',
    source,
    status: p,
    amount,
    method,
    createdAt: row?.completedAt || row?.deliveredAt || row?.updatedAt || row?.createdAt || null,
  };
}

const BOOKING_PROJECTION = {
  _id: 1,
  bookingCode: 1,
  serviceCode: 1,
  service: 1,
  status: 1,
  paymentStatus: 1,
  paymentMethod: 1,
  fareSnapshot: 1,
  pricing: 1,
  createdAt: 1,
  completedAt: 1,
  rating: 1,
  driverRating: 1,
  settlementV140: 1,
  settlementV133: 1,
  pointsAwarded: 1,
  loyaltyPoints: 1,
};

const ORDER_PROJECTION = {
  _id: 1,
  orderCode: 1,
  status: 1,
  paymentStatus: 1,
  paymentMethod: 1,
  total: 1,
  createdAt: 1,
  updatedAt: 1,
  completedAt: 1,
  deliveredAt: 1,
};

const PAYMENT_PROJECTION = {
  _id: 1,
  bookingId: 1,
  orderId: 1,
  referenceCode: 1,
  status: 1,
  amount: 1,
  total: 1,
  method: 1,
  paymentMethod: 1,
  createdAt: 1,
};

function createAnalyticsService({ getDb }) {
  const cache = new Map();
  const cacheMs = Math.max(5000, Number(process.env.ANALYTICS_CACHE_MS || 60000));

  async function report(days = 14, { forceRefresh = false } = {}) {
    const db = getDb();
    if (!db) throw new Error('MongoDB chưa sẵn sàng.');

    const safe = Math.max(1, Math.min(90, Number(days) || 14));
    const cacheKey = String(safe);
    const cached = cache.get(cacheKey);

    if (!forceRefresh && cached && Date.now() - cached.at < cacheMs) {
      return cached.value;
    }

    const since = new Date(Date.now() - safe * 86400000);

    // Chỉ lấy các field Analytics thật sự cần. Booking/Order production có thể chứa
    // GPS snapshot, message, media, dispatch metadata... rất lớn; đọc toàn document
    // làm /analytics chậm hàng chục giây trên MongoDB Atlas.
    const [catalogRows, bookings, orders, payments] = await Promise.all([
      db.collection('service_catalog')
        .find({}, { projection: { _id: 0, code: 1, name: 1 } })
        .toArray(),
      db.collection('bookings')
        .find({ createdAt: { $gte: since } }, { projection: BOOKING_PROJECTION })
        .toArray(),
      db.collection('orders')
        .find({ createdAt: { $gte: since } }, { projection: ORDER_PROJECTION })
        .toArray()
        .catch(() => []),
      db.collection('payments')
        .find({ createdAt: { $gte: since } }, { projection: PAYMENT_PROJECTION })
        .toArray()
        .catch(() => []),
    ]);

    const catalog = new Map(catalogRows.map((x) => [String(x.code || '').toUpperCase(), x]));
    const trips = bookings.map((x) => normalizeAnalyticsTrip(x, catalog));
    const completed = trips.filter((x) => x.completed);
    const cancelled = trips.filter((x) => x.cancelled);

    const dayMap = new Map();
    for (const row of trips) {
      const d = new Date(row.completedAt || row.createdAt);
      if (Number.isNaN(d.getTime())) continue;
      const key = d.toISOString().slice(0, 10);
      const cur = dayMap.get(key) || {
        date: key,
        trips: 0,
        completed: 0,
        gross: 0,
        platformRevenue: 0,
        driverNet: 0,
      };
      cur.trips += 1;
      if (row.completed) {
        cur.completed += 1;
        cur.gross += row.customerTotal;
        cur.platformRevenue += row.platformRevenue;
        cur.driverNet += row.driverNet;
      }
      dayMap.set(key, cur);
    }

    const serviceMap = new Map();
    for (const row of trips) {
      const cur = serviceMap.get(row.serviceCode) || {
        serviceCode: row.serviceCode,
        serviceName: row.serviceName,
        trips: 0,
        completed: 0,
        gross: 0,
      };
      cur.trips += 1;
      if (row.completed) {
        cur.completed += 1;
        cur.gross += row.customerTotal;
      }
      serviceMap.set(row.serviceCode, cur);
    }

    const derived = [
      ...bookings.map((x) => derivedPayment(x, 'BOOKING')),
      ...orders.map((x) => derivedPayment(x, 'ORDER')),
    ];

    const explicit = payments.map((x) => ({
      id: String(x._id),
      referenceId: String(x.bookingId || x.orderId || ''),
      referenceCode: x.referenceCode || '',
      source: 'PAYMENT',
      status: normalizePaymentStatus(x.status),
      amount: n(x.amount ?? x.total),
      method: String(x.method || x.paymentMethod || ''),
      createdAt: x.createdAt || null,
    }));

    const explicitRefs = new Set(explicit.map((x) => x.referenceId).filter(Boolean));
    const paymentRows = [
      ...explicit,
      ...derived.filter((x) => !explicitRefs.has(x.referenceId)),
    ]
      .filter((x) => x.amount > 0)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const byDay = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const orderedTrips = trips.sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0),
    );

    const value = {
      days: safe,
      kpis: {
        trips: trips.length,
        completed: completed.length,
        cancelled: cancelled.length,
        completionRate: trips.length ? (completed.length * 100) / trips.length : 0,
        grossFare: completed.reduce((s, x) => s + x.customerTotal, 0),
        platformRevenue: completed.reduce((s, x) => s + x.platformRevenue, 0),
        driverNet: completed.reduce((s, x) => s + x.driverNet, 0),
        paidCount: paymentRows.filter((x) => x.status === 'PAID').length,
        paidAmount: paymentRows
          .filter((x) => x.status === 'PAID')
          .reduce((s, x) => s + x.amount, 0),
        settlementBacklog: completed.filter(
          (x) => !['SETTLED', 'POSTED'].includes(x.settlementStatus),
        ).length,
      },
      byDay,
      services: [...serviceMap.values()],
      payments: paymentRows,
      trips: orderedTrips,
      generatedAt: new Date().toISOString(),
      cacheSeconds: Math.round(cacheMs / 1000),
    };

    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  function clearCache() {
    cache.clear();
  }

  return { report, clearCache };
}

module.exports = {
  normalizePaymentStatus,
  serviceLabel,
  normalizeAnalyticsTrip,
  createAnalyticsService,
};
