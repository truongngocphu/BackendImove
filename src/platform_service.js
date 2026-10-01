const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { completionCollectionForStep, validationDetails } = require('./database_repair');
const { recordPlatformFeeDebit, recomputeDriverPointAccount } = require('./driver_points_service');

const JWT_ACCESS_SECRET = String(process.env.JWT_ACCESS_SECRET || '');
const JWT_ISSUER = 'th79-imove';
const JWT_AUDIENCE = 'th79-imove-apps';

function safeObjectId(value) {
  try { return new ObjectId(String(value)); } catch (_) { return null; }
}

function iso(value) {
  if (!value) return null;
  try { return value.toISOString ? value.toISOString() : new Date(value).toISOString(); } catch (_) { return null; }
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value, max = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function createPlatformService({ getDb, getClient, getMatching }) {
  const router = express.Router();

  const config = {
    demoTopupEnabled: process.env.NODE_ENV !== 'production' && String(process.env.V64_DEMO_TOPUP_ENABLED || 'false').toLowerCase() === 'true',
    demoTopupMax: Math.max(10000, number(process.env.V64_DEMO_TOPUP_MAX, 500000)),
    driverWithdrawMin: Math.max(10000, number(process.env.DRIVER_WITHDRAW_MIN, 50000)),
    safetyShareHours: Math.max(1, number(process.env.SAFETY_SHARE_HOURS, 24)),
    messageMaxLength: Math.max(200, number(process.env.MESSAGE_MAX_LENGTH, 1200)),
    loyaltyVndPerPoint: Math.max(100, number(process.env.LOYALTY_VND_PER_POINT, 1000)),
    loyaltyMinTripPoints: Math.max(0, number(process.env.LOYALTY_MIN_TRIP_POINTS, 10)),
  };

  async function authenticate(req, res, next) {
    try {
      if (!JWT_ACCESS_SECRET || JWT_ACCESS_SECRET.length < 32) {
        return res.status(500).json({ message: 'JWT_ACCESS_SECRET chưa được cấu hình an toàn.' });
      }

      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Thiếu Access Token.' });
      }

      const token = header.slice(7).trim();
      const payload = jwt.verify(token, JWT_ACCESS_SECRET, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });

      const userId = safeObjectId(payload.sub);
      const db = getDb();
      if (!db || !userId) {
        return res.status(401).json({ message: 'Access Token không hợp lệ.' });
      }

      const user = await db.collection('users').findOne({
        _id: userId,
        status: 'ACTIVE',
      });

      if (!user) {
        return res.status(401).json({ message: 'Tài khoản không tồn tại hoặc đã bị khóa.' });
      }

      req.v64 = { user, payload };
      return next();
    } catch (error) {
      return res.status(401).json({
        code: error?.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: error?.name === 'TokenExpiredError'
          ? 'Phiên đăng nhập đã hết hạn.'
          : 'Access Token không hợp lệ.',
      });
    }
  }

  function hasRole(user, role) {
    return Array.isArray(user?.roles) && user.roles.includes(role);
  }

  async function driverForUser(userId) {
    const db = getDb();
    return db.collection('drivers').findOne({ userId });
  }

  async function participantContext(user, bookingId) {
    const db = getDb();
    const id = bookingId instanceof ObjectId ? bookingId : safeObjectId(bookingId);
    if (!id) return null;

    const booking = await db.collection('bookings').findOne({ _id: id });
    if (!booking) return null;

    if (String(booking.customerId) === String(user._id)) {
      return { booking, role: 'CUSTOMER', driver: null };
    }

    if (hasRole(user, 'DRIVER')) {
      const driver = await driverForUser(user._id);
      if (driver && booking.driverId && String(booking.driverId) === String(driver._id)) {
        return { booking, role: 'DRIVER', driver };
      }
    }

    return null;
  }

  async function notifyUser(userId, {
    type = 'SYSTEM',
    title,
    body,
    bookingId = null,
    data = null,
  }) {
    const db = getDb();
    const now = new Date();
    const doc = {
      userId,
      type,
      title: cleanText(title, 120),
      body: cleanText(body, 500),
      bookingId,
      data: data || null,
      readAt: null,
      createdAt: now,
    };
    const result = await db.collection('notifications').insertOne(doc);
    const payload = {
      id: String(result.insertedId),
      type: doc.type,
      title: doc.title,
      body: doc.body,
      bookingId: bookingId ? String(bookingId) : null,
      data: doc.data,
      readAt: null,
      createdAt: iso(now),
    };
    try { getMatching()?.emitToUser?.(userId, 'notification:new', payload); } catch (_) { }
    return payload;
  }

  function serializeNotification(doc) {
    return {
      id: String(doc._id),
      type: doc.type,
      title: doc.title,
      body: doc.body,
      bookingId: doc.bookingId ? String(doc.bookingId) : null,
      data: doc.data || null,
      readAt: iso(doc.readAt),
      createdAt: iso(doc.createdAt),
    };
  }

  function serializeMessage(doc) {
    return {
      id: String(doc._id),
      conversationId: String(doc.conversationId),
      senderUserId: doc.senderUserId ? String(doc.senderUserId) : null,
      senderRole: doc.senderRole || 'SYSTEM',
      type: doc.type || 'TEXT',
      text: doc.text || '',
      createdAt: iso(doc.createdAt),
    };
  }

  async function serializeConversation(doc, viewerId) {
    const db = getDb();
    const participantIds = Array.isArray(doc.participantUserIds) ? doc.participantUserIds : [];
    const otherIds = participantIds.filter((id) => String(id) !== String(viewerId));
    const others = otherIds.length
      ? await db.collection('users').find({ _id: { $in: otherIds } })
        .project({ fullName: 1, phone: 1, roles: 1 }).toArray()
      : [];

    const readAt = doc.readState?.[String(viewerId)] || null;
    const unread = await db.collection('messages').countDocuments({
      conversationId: doc._id,
      senderUserId: { $ne: viewerId },
      ...(readAt ? { createdAt: { $gt: new Date(readAt) } } : {}),
    });

    return {
      id: String(doc._id),
      type: doc.type,
      bookingId: doc.bookingId ? String(doc.bookingId) : null,
      title: doc.type === 'SUPPORT'
        ? 'TH79 iMove Support'
        : (others[0]?.fullName || doc.title || 'Cuộc trò chuyện'),
      participantCount: participantIds.length,
      otherUser: others[0] ? {
        id: String(others[0]._id),
        fullName: others[0].fullName || '',
        phone: others[0].phone || '',
        roles: others[0].roles || [],
      } : null,
      lastMessage: doc.lastMessage || '',
      lastMessageAt: iso(doc.lastMessageAt),
      unreadCount: unread,
      createdAt: iso(doc.createdAt),
      updatedAt: iso(doc.updatedAt),
    };
  }

  async function ensureWallet(user, { session = null } = {}) {
    const db = getDb();
    const type = hasRole(user, 'DRIVER') ? 'DRIVER' : 'CUSTOMER';
    const now = new Date();
    const options = { upsert: true, ...(session ? { session } : {}) };
    await db.collection('wallets').updateOne(
      { userId: user._id },
      {
        // IMPORTANT: do not write the same path in both $setOnInsert and $set.
        // MongoDB rejects that update with:
        // "Updating the path 'type' would create a conflict at 'type'".
        $setOnInsert: {
          userId: user._id,
          currency: 'VND',
          balance: 0,
          availableBalance: 0,
          lockedBalance: 0,
          createdAt: now,
        },
        $set: { type, updatedAt: now },
      },
      options,
    );
    return db.collection('wallets').findOne(
      { userId: user._id },
      session ? { session } : {},
    );
  }

  async function addWalletTransaction({
    user,
    amount,
    type,
    title,
    bookingId = null,
    reference = null,
    allowNegative = false,
    session = null,
  }) {
    const db = getDb();
    const wallet = await ensureWallet(user, { session });
    const delta = Math.round(number(amount));
    if (delta === 0) throw new Error('Số tiền giao dịch phải khác 0.');

    const query = { _id: wallet._id };
    if (delta < 0 && !allowNegative) {
      query.availableBalance = { $gte: Math.abs(delta) };
    }

    const changed = await db.collection('wallets').findOneAndUpdate(
      query,
      {
        $inc: { balance: delta, availableBalance: delta },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    );

    const nextWallet = changed?._id ? changed : changed?.value;
    if (!nextWallet) throw new Error('Số dư ví không đủ.');

    const tx = {
      walletId: wallet._id,
      userId: user._id,
      type,
      title: cleanText(title, 180),
      amount: delta,
      balanceAfter: nextWallet.balance,
      bookingId,
      reference,
      status: 'COMPLETED',
      createdAt: new Date(),
    };
    const result = await db.collection('wallet_transactions').insertOne(
      tx,
      session ? { session } : {},
    );
    return { wallet: nextWallet, transaction: { ...tx, _id: result.insertedId } };
  }

  async function ensureLoyaltyAccount(userId, { session = null } = {}) {
    const db = getDb();
    const now = new Date();
    await db.collection('loyalty_accounts').updateOne(
      { userId },
      {
        $setOnInsert: {
          userId,
          balance: 0,
          lifetimeEarned: 0,
          lifetimeSpent: 0,
          createdAt: now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true, ...(session ? { session } : {}) },
    );
    return db.collection('loyalty_accounts').findOne(
      { userId },
      session ? { session } : {},
    );
  }

  async function addLoyaltyTransaction({
    userId,
    points,
    type,
    title,
    bookingId = null,
    reference = null,
    session = null,
  }) {
    const db = getDb();
    const delta = Math.trunc(number(points));
    if (!delta) return null;

    if (bookingId && reference) {
      const existing = await db.collection('loyalty_transactions').findOne(
        { userId, bookingId, reference, status: 'COMPLETED' },
        session ? { session } : {},
      );
      if (existing) return existing;
    }

    await ensureLoyaltyAccount(userId, { session });
    const inc = {
      balance: delta,
      ...(delta > 0 ? { lifetimeEarned: delta } : { lifetimeSpent: Math.abs(delta) }),
    };
    const changed = await db.collection('loyalty_accounts').findOneAndUpdate(
      {
        userId,
        ...(delta < 0 ? { balance: { $gte: Math.abs(delta) } } : {}),
      },
      { $inc: inc, $set: { updatedAt: new Date() } },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    );
    const account = changed?._id ? changed : changed?.value;
    if (!account) throw new Error('Điểm TH79 không đủ.');

    const doc = {
      userId,
      bookingId,
      type,
      title: cleanText(title, 180),
      points: delta,
      balanceAfter: number(account.balance),
      reference,
      status: 'COMPLETED',
      createdAt: new Date(),
    };
    const result = await db.collection('loyalty_transactions').insertOne(
      doc,
      session ? { session } : {},
    );
    return { ...doc, _id: result.insertedId };
  }

  async function awardBookingPoints(booking, { session = null } = {}) {
    if (!booking?.customerId || booking.status !== 'COMPLETED') return null;
    const paid = number(
      booking.pricing?.customerTotal ||
      booking.pricing?.total ||
      booking.pricing?.tripFare ||
      0,
    );
    const points = Math.max(
      config.loyaltyMinTripPoints,
      Math.floor(paid / config.loyaltyVndPerPoint),
    );
    if (points <= 0) return null;
    return addLoyaltyTransaction({
      userId: booking.customerId,
      points,
      type: 'TRIP_REWARD',
      title: `Thưởng chuyến ${booking.bookingCode || ''}`,
      bookingId: booking._id,
      reference: `TRIP-POINTS-${String(booking._id)}`,
      session,
    });
  }

  async function databaseReady() {
    const db = getDb();
    if (!db) return;
    const collections = [
      'notifications',
      'device_tokens',
      'safety_events',
      'safety_shares',
      'wallets',
      'wallet_transactions',
      'loyalty_accounts',
      'loyalty_transactions',
      'withdrawal_requests',
      'support_tickets',
      'ratings',
      'conversations',
      'messages',
      'lost_found_reports',
      'fraud_flags',
    ];

    const existing = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name),
    );

    for (const name of collections) {
      if (!existing.has(name)) await db.createCollection(name);
    }

    await Promise.all([
      db.collection('notifications').createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_notifications_user_created' }),
      db.collection('device_tokens').createIndex({ token: 1 }, { unique: true, name: 'uq_device_token' }),
      db.collection('wallets').createIndex({ userId: 1 }, { unique: true, name: 'uq_wallet_user' }),
      db.collection('wallet_transactions').createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_wallet_tx_user' }),
      db.collection('wallet_transactions').createIndex(
        { bookingId: 1, type: 1 },
        {
          unique: true,
          partialFilterExpression: {
            bookingId: { $exists: true },
            type: { $in: ['DRIVER_TRIP_EARNING', 'BOOKING_PAYMENT'] },
          },
          name: 'uq_wallet_booking_type',
        },
      ),
      db.collection('loyalty_accounts').createIndex({ userId: 1 }, { unique: true, name: 'uq_loyalty_user' }),
      db.collection('loyalty_transactions').createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_loyalty_user_created' }),
      db.collection('loyalty_transactions').createIndex(
        { userId: 1, bookingId: 1, reference: 1 },
        {
          unique: true,
          partialFilterExpression: { bookingId: { $exists: true, $type: 'objectId' }, reference: { $exists: true, $type: 'string' } },
          name: 'uq_loyalty_booking_reference',
        },
      ),
      db.collection('withdrawal_requests').createIndex({ driverId: 1, createdAt: -1 }, { name: 'idx_withdraw_driver' }),
      db.collection('withdrawal_requests').createIndex(
        { userId: 1, idempotencyKey: 1 },
        { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true, $type: 'string' } }, name: 'uq_withdraw_idempotency' },
      ),
      db.collection('support_tickets').createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_ticket_user' }),
      db.collection('ratings').createIndex({ bookingId: 1, fromUserId: 1 }, { unique: true, name: 'uq_rating_booking_from' }),
      db.collection('conversations').createIndex(
        { type: 1, bookingId: 1, driverId: 1 },
        {
          unique: true,
          partialFilterExpression: { type: 'BOOKING' },
          name: 'uq_booking_driver_conversation',
        },
      ),
      db.collection('conversations').createIndex({ participantUserIds: 1, updatedAt: -1 }, { name: 'idx_conversation_participant' }),
      db.collection('messages').createIndex({ conversationId: 1, createdAt: 1 }, { name: 'idx_messages_conversation' }),
      db.collection('messages').createIndex(
        { conversationId: 1, idempotencyKey: 1 },
        {
          unique: true,
          partialFilterExpression: {
            idempotencyKey: {
              $exists: true,
              $type: 'string'
            }
          },
          name: 'uq_message_idempotency'
        }
      ),
      db.collection('safety_shares').createIndex({ tokenHash: 1 }, { unique: true, name: 'uq_safety_share_token' }),
      db.collection('safety_shares').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_safety_share' }),
    ]);
  }


  async function runSettlementStage(stage, work) {
    const client = getClient?.();
    if (!client) throw Object.assign(new Error('MongoDB client chưa sẵn sàng.'), { settlementStage: stage });
    const session = client.startSession();
    try {
      let value = null;
      await session.withTransaction(async () => {
        value = await work(session);
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      return { ok: true, value };
    } catch (error) {
      error.settlementStage = stage;
      throw error;
    } finally {
      await session.endSession();
    }
  }

  function settlementErrorPayload(stage, error) {
    return {
      stage,
      code: error?.code || null,
      message: String(error?.message || 'Settlement failed').slice(0, 1000),
      validationDetails: validationDetails(error),
    };
  }

  async function markSettlementState(bookingId, state) {
    const db = getDb();
    if (!db) return;
    try {
      await db.collection('bookings').updateOne(
        { _id: bookingId, status: 'COMPLETED' },
        {
          $set: {
            settlementV133: {
              version: 1,
              ...state,
              lastAttemptAt: new Date(),
            },
            updatedAt: new Date(),
          },
        },
      );
    } catch (error) {
      console.error('[SETTLEMENT STATE]', error.message);
    }
  }

  async function reconcileCompletedBookingSettlement(bookingOrId) {
    const db = getDb();
    if (!db) throw new Error('MongoDB chưa sẵn sàng.');
    const bookingId = bookingOrId?._id || (bookingOrId instanceof ObjectId ? bookingOrId : safeObjectId(bookingOrId));
    if (!bookingId) throw new Error('Booking id không hợp lệ.');
    const booking = bookingOrId?._id
      ? bookingOrId
      : await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking || booking.status !== 'COMPLETED') {
      return { ok: false, status: 'SKIPPED', reason: 'BOOKING_NOT_COMPLETED', bookingId: String(bookingId) };
    }

    const result = {
      ok: true,
      bookingId: String(bookingId),
      status: 'SETTLED',
      stages: {
        loyalty: { stage: 'LOYALTY_SETTLEMENT', status: 'PENDING' },
        driverEarning: { stage: 'DRIVER_EARNING', status: 'PENDING' },
      },
    };

    try {
      const loyalty = await runSettlementStage('LOYALTY_SETTLEMENT', async (session) => {
        return awardBookingPoints(booking, { session });
      });
      result.stages.loyalty = {
        stage: 'LOYALTY_SETTLEMENT',
        status: loyalty.value ? 'SETTLED' : 'SKIPPED',
      };
    } catch (error) {
      result.ok = false;
      result.stages.loyalty = {
        stage: 'LOYALTY_SETTLEMENT',
        status: 'FAILED',
        error: settlementErrorPayload('LOYALTY_SETTLEMENT', error),
      };
      console.error('[LOYALTY_SETTLEMENT]', JSON.stringify(result.stages.loyalty.error, null, 2));
    }

    let earningNotification = null;
    try {
      const earning = await runSettlementStage('DRIVER_EARNING', async (session) => {
        const currentBooking = await db.collection('bookings').findOne(
          { _id: bookingId, status: 'COMPLETED' },
          { session },
        );
        if (!currentBooking?.driverId) return { status: 'SKIPPED', reason: 'NO_DRIVER' };

        const existing = await db.collection('wallet_transactions').findOne(
          { bookingId, type: 'DRIVER_TRIP_EARNING', status: 'COMPLETED' },
          { session },
        );
        if (existing) return { status: 'SETTLED', existing: true, transactionId: existing._id };

        const driver = await db.collection('drivers').findOne({ _id: currentBooking.driverId }, { session });
        if (!driver?.userId) return { status: 'SKIPPED', reason: 'DRIVER_USER_MISSING' };
        const driverUser = await db.collection('users').findOne({ _id: driver.userId }, { session });
        if (!driverUser) return { status: 'SKIPPED', reason: 'DRIVER_USER_MISSING' };

        // CASH-FIRST 1.6.0:
        // Driver collects cash directly from the customer. iMove therefore does
        // not credit a withdrawable wallet for CASH trips. Platform commission
        // is instead converted to driver points and deducted idempotently.
        const pointDebit = await recordPlatformFeeDebit(db, {
          booking: currentBooking,
          driverId: driver._id,
          userId: driverUser._id,
        });
        await recomputeDriverPointAccount(db, {
          driverId: driver._id,
          userId: driverUser._id,
        });

        const paymentMethod = String(
          currentBooking.paymentMethod ||
          currentBooking.payment?.method ||
          currentBooking.pricing?.paymentMethod ||
          'CASH',
        ).toUpperCase();

        if (paymentMethod === 'CASH') {
          return {
            status: 'SKIPPED',
            reason: 'CASH_COLLECTED_BY_DRIVER',
            amount: 0,
            userId: driverUser._id,
            platformFeePoints: pointDebit.points || 0,
          };
        }

        const earningAmount = Math.round(number(
          currentBooking.pricing?.driverNetAmount || currentBooking.pricing?.driverGrossAmount || 0,
        ));
        if (earningAmount <= 0) return { status: 'SKIPPED', reason: 'NO_EARNING_AMOUNT' };

        const walletResult = await addWalletTransaction({
          user: driverUser,
          amount: earningAmount,
          type: 'DRIVER_TRIP_EARNING',
          title: `Thu nhập chuyến ${currentBooking.bookingCode || ''}`,
          bookingId,
          reference: `TRIP-${String(bookingId)}`,
          session,
        });
        return {
          status: 'SETTLED',
          existing: false,
          amount: earningAmount,
          userId: driverUser._id,
          transactionId: walletResult.transaction?._id || null,
          platformFeePoints: pointDebit.points || 0,
        };
      });
      const payload = earning.value || { status: 'SKIPPED' };
      result.stages.driverEarning = {
        stage: 'DRIVER_EARNING',
        status: payload.status || 'SETTLED',
        existing: Boolean(payload.existing),
        amount: payload.amount || 0,
      };
      if (payload.status === 'SETTLED' && !payload.existing && payload.userId && payload.amount > 0) {
        earningNotification = payload;
      }
    } catch (error) {
      result.ok = false;
      result.stages.driverEarning = {
        stage: 'DRIVER_EARNING',
        status: 'FAILED',
        error: settlementErrorPayload('DRIVER_EARNING', error),
      };
      console.error('[DRIVER_EARNING]', JSON.stringify(result.stages.driverEarning.error, null, 2));
    }

    const stageStatuses = Object.values(result.stages).map((x) => x.status);
    const failed = stageStatuses.filter((x) => x === 'FAILED').length;
    const settled = stageStatuses.filter((x) => ['SETTLED', 'SKIPPED'].includes(x)).length;
    result.status = failed === 0 ? 'SETTLED' : settled > 0 ? 'PARTIAL' : 'FAILED';
    result.ok = failed === 0;

    await markSettlementState(bookingId, {
      status: result.status,
      stages: result.stages,
    });

    if (earningNotification) {
      await notifyUser(earningNotification.userId, {
        type: 'PAYMENT',
        title: 'Thu nhập chuyến đã ghi nhận',
        body: `${booking.bookingCode || 'Chuyến'}: +${earningNotification.amount.toLocaleString('vi-VN')}đ`,
        bookingId,
      }).catch((error) => console.error('[DRIVER_EARNING NOTIFY]', error.message));
    }
    return result;
  }

  async function settleCompletedBooking(booking) {
    return reconcileCompletedBookingSettlement(booking);
  }

  async function completeBookingTransaction({ bookingId, expectedStatus = 'IN_PROGRESS', changedAt = new Date() }) {
    const db = getDb();
    const client = getClient?.();
    const id = bookingId instanceof ObjectId ? bookingId : safeObjectId(bookingId);
    if (!db || !client || !id) throw new Error('MongoDB/booking chưa sẵn sàng.');

    const session = client.startSession();
    let completedBooking = null;
    let completionStep = 'BOOKING_COMMIT';
    try {
      await session.withTransaction(async () => {
        completionStep = 'BOOKING_COMMIT';
        const booking = await db.collection('bookings').findOne({ _id: id, status: expectedStatus }, { session });
        if (!booking) {
          const existing = await db.collection('bookings').findOne({ _id: id }, { session });
          if (existing?.status === 'COMPLETED') {
            completedBooking = existing;
            return;
          }
          throw Object.assign(new Error('Trạng thái chuyến vừa thay đổi trên thiết bị khác.'), { httpStatus: 409, completionStep: 'BOOKING_COMMIT' });
        }

        const updated = await db.collection('bookings').findOneAndUpdate(
          { _id: id, status: expectedStatus },
          {
            $set: {
              status: 'COMPLETED',
              completedAt: changedAt,
              updatedAt: changedAt,
              settlementV133: {
                version: 1,
                status: 'PENDING',
                stages: {
                  loyalty: { stage: 'LOYALTY_SETTLEMENT', status: 'PENDING' },
                  driverEarning: { stage: 'DRIVER_EARNING', status: 'PENDING' },
                },
                lastAttemptAt: null,
              },
            },
          },
          { returnDocument: 'after', session },
        );
        completedBooking = updated?._id ? updated : updated?.value;
        if (!completedBooking) throw Object.assign(new Error('Không thể hoàn tất chuyến.'), { httpStatus: 409, completionStep: 'BOOKING_COMMIT' });

        if (completedBooking.driverId) {
          completionStep = 'DRIVER_RELEASE';
          await db.collection('drivers').updateOne(
            { _id: completedBooking.driverId },
            {
              $set: {
                onlineStatus: 'ONLINE',
                activeBookingId: null,
                currentOfferBookingId: null,
                currentOfferExpiresAt: null,
                updatedAt: changedAt,
              },
              $inc: { completedTrips: 1 },
            },
            { session },
          );
        }
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } catch (error) {
      const step = error?.completionStep || completionStep || 'BOOKING_VALIDATION';
      error.completionStep = step;
      error.validationCollection = error?.validationCollection || completionCollectionForStep(step);
      const validationFailure = Number(error?.code) === 121 || String(error?.message || '').includes('Document failed validation');
      if (validationFailure) {
        console.error('[COMPLETE BOOKING VALIDATION]', JSON.stringify({
          step,
          bookingId: String(id),
          collection: error.validationCollection,
          code: error?.code,
          message: error?.message,
          errInfo: error?.errInfo || null,
        }, null, 2));
        error.validationDetails = validationDetails(error);

        // Compatibility fallback for legacy Atlas validators. Commit only the
        // authoritative terminal booking state first; driver release and
        // settlement metadata are best-effort afterwards. A validator on an
        // auxiliary collection must not leave an actually completed trip stuck
        // at IN_PROGRESS forever.
        const fallback = await db.collection('bookings').findOneAndUpdate(
          { _id: id, status: expectedStatus },
          { $set: { status: 'COMPLETED', completedAt: changedAt, updatedAt: changedAt } },
          { returnDocument: 'after' },
        );
        completedBooking = fallback?._id ? fallback : fallback?.value;
        if (!completedBooking) {
          const existing = await db.collection('bookings').findOne({ _id: id });
          if (existing?.status === 'COMPLETED') completedBooking = existing;
        }
        if (completedBooking) {
          if (completedBooking.driverId) {
            try {
              await db.collection('drivers').updateOne(
                { _id: completedBooking.driverId },
                { $set: { onlineStatus: 'ONLINE', activeBookingId: null, currentOfferBookingId: null, currentOfferExpiresAt: null, updatedAt: changedAt } },
              );
            } catch (releaseError) {
              console.error('[DRIVER RELEASE FALLBACK]', releaseError.message);
            }
          }
          console.warn('[COMPLETE BOOKING FALLBACK] Legacy validator compatibility path used for', String(id));
          return completedBooking;
        }
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return completedBooking;
  }

  // ----------------------- V6.0: ride recovery -----------------------
  router.get('/bookings/active', authenticate, async (req, res) => {
    try {
      const db = getDb();
      const user = req.v64.user;
      let query;
      if (hasRole(user, 'DRIVER')) {
        const driver = await driverForUser(user._id);
        if (!driver) return res.json({ booking: null });
        query = {
          driverId: driver._id,
          status: { $in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
        };
      } else {
        query = {
          customerId: user._id,
          status: { $in: ['SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
        };
      }
      const booking = await db.collection('bookings').findOne(query, { sort: { createdAt: -1 } });
      return res.json({ booking: booking ? getMatching()?.serializeBookingPublic?.(booking) || null : null });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });


  // ----------------------- V6.7: participant trip detail + timeline -----------------------
  router.get('/bookings/:id/detail', authenticate, async (req, res) => {
    try {
      const ctx = await participantContext(req.v64.user, req.params.id);
      if (!ctx) return res.status(403).json({ message: 'Bạn không có quyền xem chuyến này.' });
      const db = getDb();
      const booking = ctx.booking;
      const events = await db.collection('booking_events')
        .find({ bookingId: booking._id })
        .sort({ createdAt: 1 })
        .limit(200)
        .toArray();
      const walletTx = await db.collection('wallet_transactions')
        .find({ bookingId: booking._id })
        .sort({ createdAt: 1 })
        .limit(30)
        .toArray();
      const rating = await db.collection('ratings').findOne({ bookingId: booking._id });
      const serialized = getMatching()?.serializeBookingPublic?.(booking) || null;
      return res.json({
        booking: serialized,
        role: ctx.role,
        events: events.map((e) => ({
          id: String(e._id),
          type: e.type,
          actorType: e.actorType,
          payload: e.payload || null,
          createdAt: iso(e.createdAt),
        })),
        financials: walletTx.map((x) => ({
          id: String(x._id),
          type: x.type,
          title: x.title || null,
          amount: number(x.amount),
          status: x.status || null,
          createdAt: iso(x.createdAt),
        })),
        rating: rating ? { score: number(rating.score), comment: rating.comment || '', createdAt: iso(rating.createdAt) } : null,
        timestamps: {
          createdAt: iso(booking.createdAt),
          assignedAt: iso(booking.assignedAt),
          driverDepartedAt: iso(booking.driverDepartedAt),
          driverArrivedAt: iso(booking.driverArrivedAt),
          startedAt: iso(booking.startedAt),
          completedAt: iso(booking.completedAt),
          cancelledAt: iso(booking.cancelledAt || booking.cancellation?.cancelledAt),
        },
      });
    } catch (error) {
      const status = Number(error?.httpStatus || 500);
      return res.status(status).json({ message: error.message });
    }
  });

  router.post('/bookings/:id/continue-search', authenticate, async (req, res) => {
    try {
      const user = req.v64.user;
      const ctx = await participantContext(user, req.params.id);
      if (!ctx || ctx.role !== 'CUSTOMER') return res.status(403).json({ message: 'Bạn không có quyền tiếp tục tìm tài xế cho chuyến này.' });
      if (!['SEARCHING', 'EXPIRED'].includes(ctx.booking.status)) {
        return res.status(409).json({ message: 'Chuyến hiện không ở trạng thái có thể tìm lại tài xế.' });
      }
      const db = getDb();
      const changedAt = new Date();
      await db.collection('bookings').updateOne(
        { _id: ctx.booking._id },
        {
          $set: {
            status: 'SEARCHING',
            createdAt: changedAt,
            requestedAt: changedAt,
            expiredAt: null,
            updatedAt: changedAt,
            'dispatch.status': 'SEARCHING',
            'dispatch.finishedAt': null,
          },
        },
      );
      getMatching()?.dispatchBooking?.(ctx.booking._id, { force: true }).catch(() => { });
      const updated = await db.collection('bookings').findOne({ _id: ctx.booking._id });
      getMatching()?.emitBookingUpdate?.(updated);
      return res.json(getMatching()?.serializeBookingPublic?.(updated) || { id: String(updated._id), status: updated.status });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  // ----------------------- V6.1: notifications + safety -----------------------
  router.get('/notifications', authenticate, async (req, res) => {
    const db = getDb();
    const items = await db.collection('notifications')
      .find({ userId: req.v64.user._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return res.json(items.map(serializeNotification));
  });

  router.post('/notifications/:id/read', authenticate, async (req, res) => {
    const id = safeObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Notification id không hợp lệ.' });
    await getDb().collection('notifications').updateOne(
      { _id: id, userId: req.v64.user._id },
      { $set: { readAt: new Date() } },
    );
    return res.json({ ok: true });
  });

  router.post('/devices/register', authenticate, async (req, res) => {
    const token = cleanText(req.body?.token, 1000);
    if (!token) return res.status(400).json({ message: 'Thiếu device token.' });
    const platform = cleanText(req.body?.platform, 32) || 'UNKNOWN';
    await getDb().collection('device_tokens').updateOne(
      { token },
      {
        $set: {
          token,
          userId: req.v64.user._id,
          platform,
          status: 'ACTIVE',
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    return res.json({ ok: true, pushMode: 'FCM_READY_REQUIRES_SERVER_CREDENTIALS' });
  });

  router.post('/safety/sos', authenticate, async (req, res) => {
    try {
      const db = getDb();
      const user = req.v64.user;
      let bookingId = null;
      let participant = null;
      if (req.body?.bookingId) {
        bookingId = safeObjectId(req.body.bookingId);
        if (!bookingId) return res.status(400).json({ message: 'Booking id không hợp lệ.' });
        participant = await participantContext(user, bookingId);
        if (!participant) return res.status(403).json({ message: 'Bạn không thuộc chuyến này.' });
      }
      const event = {
        userId: user._id,
        bookingId,
        role: participant?.role || (hasRole(user, 'DRIVER') ? 'DRIVER' : 'CUSTOMER'),
        location: (
          Number.isFinite(Number(req.body?.latitude)) &&
          Number.isFinite(Number(req.body?.longitude))
        ) ? {
          type: 'Point',
          coordinates: [Number(req.body.longitude), Number(req.body.latitude)],
        } : null,
        message: cleanText(req.body?.message, 500),
        status: 'OPEN',
        createdAt: new Date(),
      };
      const result = await db.collection('safety_events').insertOne(event);

      if (participant?.booking) {
        if (event.role === 'CUSTOMER' && participant.booking.driverId) {
          const driver = await db.collection('drivers').findOne({ _id: participant.booking.driverId });
          if (driver?.userId) {
            await notifyUser(driver.userId, {
              type: 'SAFETY',
              title: 'Cảnh báo an toàn từ khách hàng',
              body: 'Khách hàng vừa kích hoạt SOS trên chuyến đang thực hiện.',
              bookingId,
            });
          }
        } else if (event.role === 'DRIVER') {
          await notifyUser(participant.booking.customerId, {
            type: 'SAFETY',
            title: 'Cảnh báo an toàn chuyến đi',
            body: 'Tài xế vừa kích hoạt SOS trên chuyến đang thực hiện.',
            bookingId,
          });
        }
      }

      return res.status(201).json({ ok: true, id: String(result.insertedId), status: 'OPEN' });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/safety/share/:bookingId', authenticate, async (req, res) => {
    try {
      const user = req.v64.user;
      const ctx = await participantContext(user, req.params.bookingId);
      if (!ctx) return res.status(403).json({ message: 'Bạn không thuộc chuyến này.' });

      const rawToken = crypto.randomBytes(24).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + config.safetyShareHours * 3600 * 1000);

      await getDb().collection('safety_shares').insertOne({
        tokenHash,
        bookingId: ctx.booking._id,
        createdByUserId: user._id,
        expiresAt,
        createdAt: new Date(),
      });

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      return res.status(201).json({
        token: rawToken,
        shareUrl: `${baseUrl}/api/v6/public/share/${rawToken}`,
        expiresAt: iso(expiresAt),
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/public/share/:token', async (req, res) => {
    try {
      const tokenHash = crypto.createHash('sha256').update(String(req.params.token || '')).digest('hex');
      const db = getDb();
      const share = await db.collection('safety_shares').findOne({
        tokenHash,
        expiresAt: { $gt: new Date() },
      });
      if (!share) return res.status(404).json({ message: 'Liên kết chia sẻ không tồn tại hoặc đã hết hạn.' });

      const booking = await db.collection('bookings').findOne({ _id: share.bookingId });
      if (!booking) return res.status(404).json({ message: 'Không tìm thấy chuyến.' });

      let driverLocation = null;
      if (booking.driverId) {
        const loc = await db.collection('driver_locations').findOne({ driverId: booking.driverId });
        if (loc?.location?.coordinates) {
          driverLocation = {
            latitude: loc.location.coordinates[1],
            longitude: loc.location.coordinates[0],
            updatedAt: iso(loc.updatedAt),
          };
        }
      }
      return res.json({
        code: booking.bookingCode,
        status: booking.status,
        pickup: booking.pickup?.address || '',
        destination: booking.destination?.address || '',
        driver: booking.driverSnapshot ? {
          fullName: booking.driverSnapshot.fullName || '',
          vehiclePlate: booking.driverSnapshot.vehiclePlate || '',
        } : null,
        driverLocation,
        updatedAt: iso(booking.updatedAt),
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  // ----------------------- V6.2: wallet/payment -----------------------
  router.get('/wallet', authenticate, async (req, res) => {
    try {
      const wallet = await ensureWallet(req.v64.user);
      const tx = await getDb().collection('wallet_transactions')
        .find({ userId: req.v64.user._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
      return res.json({
        wallet: {
          id: String(wallet._id),
          type: wallet.type,
          currency: wallet.currency,
          balance: number(wallet.balance),
          availableBalance: number(wallet.availableBalance),
          lockedBalance: number(wallet.lockedBalance),
        },
        transactions: tx.map((item) => ({
          id: String(item._id),
          type: item.type,
          title: item.title,
          amount: number(item.amount),
          balanceAfter: number(item.balanceAfter),
          bookingId: item.bookingId ? String(item.bookingId) : null,
          status: item.status,
          createdAt: iso(item.createdAt),
        })),
        demoTopupEnabled: config.demoTopupEnabled,
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  // ----------------------- V6.5: TH79 Points -----------------------
  router.get('/loyalty', authenticate, async (req, res) => {
    try {
      const user = req.v64.user;
      if (!hasRole(user, 'CUSTOMER')) {
        return res.status(403).json({ message: 'TH79 Points dành cho khách hàng.' });
      }
      const account = await ensureLoyaltyAccount(user._id);
      const tx = await getDb().collection('loyalty_transactions')
        .find({ userId: user._id, status: 'COMPLETED' })
        .sort({ createdAt: -1 })
        .limit(60)
        .toArray();
      const lifetimeEarned = number(account.lifetimeEarned);
      const tier = lifetimeEarned >= 10000
        ? 'DIAMOND'
        : lifetimeEarned >= 5000
          ? 'GOLD'
          : lifetimeEarned >= 2000
            ? 'SILVER'
            : 'MEMBER';
      return res.json({
        account: {
          balance: number(account.balance),
          lifetimeEarned,
          lifetimeSpent: number(account.lifetimeSpent),
          tier,
        },
        earningRule: {
          vndPerPoint: config.loyaltyVndPerPoint,
          minimumTripPoints: config.loyaltyMinTripPoints,
        },
        transactions: tx.map((item) => ({
          id: String(item._id),
          type: item.type,
          title: item.title,
          points: number(item.points),
          balanceAfter: number(item.balanceAfter),
          bookingId: item.bookingId ? String(item.bookingId) : null,
          status: item.status,
          createdAt: iso(item.createdAt),
        })),
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/wallet/demo-credit', authenticate, async (req, res) => {
    try {
      if (!config.demoTopupEnabled) {
        return res.status(403).json({ message: 'Nạp tiền demo đã bị tắt.' });
      }
      const amount = Math.round(number(req.body?.amount));
      if (amount < 10000 || amount > config.demoTopupMax) {
        return res.status(400).json({ message: `Số tiền demo phải từ 10.000đ đến ${config.demoTopupMax.toLocaleString('vi-VN')}đ.` });
      }
      const result = await addWalletTransaction({
        user: req.v64.user,
        amount,
        type: 'DEMO_TOPUP',
        title: 'Nạp tiền Ví TH79 (DEMO)',
        reference: `DEMO-${Date.now()}`,
      });
      return res.json({
        ok: true,
        balance: number(result.wallet.balance),
        availableBalance: number(result.wallet.availableBalance),
      });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.post('/wallet/pay-booking/:bookingId', authenticate, async (req, res) => {
    const client = getClient?.();
    if (!client) return res.status(503).json({ message: 'MongoDB chưa sẵn sàng cho transaction.' });
    const session = client.startSession();
    try {
      const ctx = await participantContext(req.v64.user, req.params.bookingId);
      if (!ctx || ctx.role !== 'CUSTOMER') return res.status(403).json({ message: 'Bạn không có quyền thanh toán chuyến này.' });

      let responsePayload = null;
      await session.withTransaction(async () => {
        const db = getDb();
        const booking = await db.collection('bookings').findOne(
          { _id: ctx.booking._id, customerId: req.v64.user._id },
          { session },
        );
        if (!booking) throw Object.assign(new Error('Không tìm thấy chuyến.'), { httpStatus: 404 });
        if (booking.status !== 'COMPLETED') {
          throw Object.assign(new Error('Chỉ thanh toán ví sau khi chuyến hoàn thành.'), { httpStatus: 409 });
        }
        if (booking.paymentStatus === 'PAID') {
          throw Object.assign(new Error('Chuyến này đã được thanh toán.'), { httpStatus: 409 });
        }

        const already = await db.collection('wallet_transactions').findOne(
          {
            userId: req.v64.user._id,
            bookingId: booking._id,
            type: 'BOOKING_PAYMENT',
            status: 'COMPLETED',
          },
          { session },
        );
        if (already) {
          throw Object.assign(new Error('Chuyến này đã được thanh toán bằng Ví TH79.'), { httpStatus: 409 });
        }

        const amount = Math.round(number(booking.pricing?.customerTotal || booking.pricing?.total || 0));
        if (amount <= 0) throw Object.assign(new Error('Không xác định được số tiền chuyến.'), { httpStatus: 400 });

        const result = await addWalletTransaction({
          user: req.v64.user,
          amount: -amount,
          type: 'BOOKING_PAYMENT',
          title: `Thanh toán chuyến ${booking.bookingCode || ''}`,
          bookingId: booking._id,
          reference: `BOOKING-PAYMENT-${String(booking._id)}`,
          session,
        });

        const changed = await db.collection('bookings').updateOne(
          { _id: booking._id, paymentStatus: { $ne: 'PAID' } },
          { $set: { paymentMethod: 'WALLET', paymentStatus: 'PAID', paidAt: new Date(), updatedAt: new Date() } },
          { session },
        );
        if (changed.modifiedCount !== 1) {
          throw Object.assign(new Error('Trạng thái thanh toán đã thay đổi, vui lòng kiểm tra lại.'), { httpStatus: 409 });
        }
        responsePayload = { ok: true, balance: number(result.wallet.balance), paid: amount };
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      return res.json(responsePayload);
    } catch (error) {
      const status = Number(error?.httpStatus) || (error?.code === 11000 ? 409 : 400);
      return res.status(status).json({ message: error?.code === 11000 ? 'Giao dịch đã được xử lý trước đó.' : error.message });
    } finally {
      await session.endSession();
    }
  });

  // ----------------------- V6.3: driver finance -----------------------
  router.get('/driver/trips', authenticate, async (req, res) => {
    try {
      const user = req.v64.user;
      if (!hasRole(user, 'DRIVER')) return res.status(403).json({ message: 'Chỉ dành cho tài xế.' });
      const driver = await driverForUser(user._id);
      if (!driver) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      const limit = Math.max(1, Math.min(100, Math.round(number(req.query.limit, 50))));
      const items = await getDb().collection('bookings')
        .find({ driverId: driver._id })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
      return res.json(items.map((x) => ({
        id: String(x._id),
        code: x.bookingCode || '',
        status: x.status || '',
        pickup: x.pickup?.address || '',
        destination: x.destination?.address || '',
        grossAmount: number(x.pricing?.driverGrossAmount || x.pricing?.tripFare),
        commission: number(x.pricing?.platformCommission),
        netAmount: number(x.pricing?.driverNetAmount),
        createdAt: iso(x.createdAt),
        completedAt: iso(x.completedAt),
      })));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/driver/finance', authenticate, async (req, res) => {
    try {
      const user = req.v64.user;
      if (!hasRole(user, 'DRIVER')) return res.status(403).json({ message: 'Chỉ dành cho tài xế.' });
      const driver = await driverForUser(user._id);
      if (!driver) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });

      const days = Math.max(1, Math.min(365, Math.round(number(req.query.days, 30))));
      const db = getDb();
      const now = new Date();
      const since = new Date(now.getTime() - days * 86400 * 1000);
      const since7 = new Date(now.getTime() - 7 * 86400 * 1000);
      const since30 = new Date(now.getTime() - 30 * 86400 * 1000);
      const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const startVnUtc = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate()) - 7 * 60 * 60 * 1000;
      const sinceToday = new Date(startVnUtc);

      const [trips, ledger, wallet, withdrawals] = await Promise.all([
        db.collection('bookings').find({
          driverId: driver._id,
          status: 'COMPLETED',
          completedAt: { $gte: since },
        }).project({ pricing: 1, completedAt: 1, bookingCode: 1 }).sort({ completedAt: -1 }).toArray(),
        db.collection('wallet_transactions').find({
          userId: user._id,
          type: 'DRIVER_TRIP_EARNING',
          status: 'COMPLETED',
          createdAt: { $gte: new Date(now.getTime() - 365 * 86400 * 1000) },
        }).sort({ createdAt: -1 }).limit(600).toArray(),
        ensureWallet(user),
        db.collection('withdrawal_requests').find({ driverId: driver._id }).sort({ createdAt: -1 }).limit(20).toArray(),
      ]);

      const bookingGross = trips.reduce((sum, x) => sum + number(x.pricing?.driverGrossAmount || x.pricing?.tripFare || 0), 0);
      const bookingCommission = trips.reduce((sum, x) => sum + number(x.pricing?.platformCommission || 0), 0);
      const bookingNet = trips.reduce((sum, x) => sum + number(x.pricing?.driverNetAmount || 0), 0);
      const sumLedger = (after) => ledger
        .filter((x) => new Date(x.createdAt) >= after)
        .reduce((sum, x) => sum + number(x.amount), 0);
      const periodAmount = sumLedger(since);
      const todayAmount = sumLedger(sinceToday);
      const weekAmount = sumLedger(since7);
      const monthAmount = sumLedger(since30);
      const periodTx = ledger.filter((x) => new Date(x.createdAt) >= since);

      return res.json({
        source: 'WALLET_LEDGER',
        periodDays: days,
        completedTrips: trips.length,
        settledTrips: periodTx.length,
        grossAmount: Math.round(bookingGross),
        platformCommission: Math.round(bookingCommission),
        bookingNetAmount: Math.round(bookingNet),
        netAmount: Math.round(periodAmount || bookingNet),
        todayAmount: Math.round(todayAmount),
        weekAmount: Math.round(weekAmount),
        monthAmount: Math.round(monthAmount),
        wallet: {
          balance: number(wallet.balance),
          availableBalance: number(wallet.availableBalance),
          lockedBalance: number(wallet.lockedBalance),
        },
        recentTransactions: ledger.slice(0, 30).map((x) => ({
          id: String(x._id),
          title: x.title || 'Thu nhập chuyến',
          amount: number(x.amount),
          balanceAfter: number(x.balanceAfter),
          bookingId: x.bookingId ? String(x.bookingId) : null,
          createdAt: iso(x.createdAt),
        })),
        recentTrips: trips.slice(0, 20).map((x) => ({
          code: x.bookingCode,
          grossAmount: number(x.pricing?.driverGrossAmount),
          commission: number(x.pricing?.platformCommission),
          netAmount: number(x.pricing?.driverNetAmount),
          completedAt: iso(x.completedAt),
        })),
        withdrawals: withdrawals.map((x) => ({
          id: String(x._id),
          amount: number(x.amount),
          status: x.status,
          createdAt: iso(x.createdAt),
        })),
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/driver/withdrawals', authenticate, async (req, res) => {
    const client = getClient?.();
    if (!client) return res.status(503).json({ message: 'MongoDB chưa sẵn sàng cho transaction.' });
    const session = client.startSession();
    try {
      const user = req.v64.user;
      if (!hasRole(user, 'DRIVER')) return res.status(403).json({ message: 'Chỉ dành cho tài xế.' });
      const driver = await driverForUser(user._id);
      if (!driver) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });

      const amount = Math.round(number(req.body?.amount));
      if (amount < config.driverWithdrawMin) {
        return res.status(400).json({ message: `Số tiền rút tối thiểu ${config.driverWithdrawMin.toLocaleString('vi-VN')}đ.` });
      }

      const idempotencyKey = cleanText(req.body?.idempotencyKey, 120) || crypto.randomUUID();
      let payload = null;
      await session.withTransaction(async () => {
        const db = getDb();
        const duplicate = await db.collection('withdrawal_requests').findOne(
          { userId: user._id, idempotencyKey },
          { session },
        );
        if (duplicate) {
          payload = { id: String(duplicate._id), amount: number(duplicate.amount), status: duplicate.status, duplicate: true };
          return;
        }

        const wallet = await ensureWallet(user, { session });
        const changed = await db.collection('wallets').findOneAndUpdate(
          { _id: wallet._id, availableBalance: { $gte: amount } },
          {
            $inc: { availableBalance: -amount, lockedBalance: amount },
            $set: { updatedAt: new Date() },
          },
          { returnDocument: 'after', session },
        );
        const nextWallet = changed?._id ? changed : changed?.value;
        if (!nextWallet) {
          throw Object.assign(new Error('Số dư khả dụng không đủ hoặc đã thay đổi.'), { httpStatus: 409 });
        }

        const request = {
          driverId: driver._id,
          userId: user._id,
          walletId: wallet._id,
          amount,
          status: 'PENDING',
          idempotencyKey,
          bankAccountId: req.body?.bankAccountId ? safeObjectId(req.body.bankAccountId) : null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const result = await db.collection('withdrawal_requests').insertOne(request, { session });
        payload = {
          id: String(result.insertedId),
          amount,
          status: 'PENDING',
          availableBalance: number(nextWallet.availableBalance),
          lockedBalance: number(nextWallet.lockedBalance),
        };
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      return res.status(payload?.duplicate ? 200 : 201).json(payload);
    } catch (error) {
      const status = Number(error?.httpStatus) || (error?.code === 11000 ? 409 : 500);
      return res.status(status).json({ message: error?.code === 11000 ? 'Yêu cầu rút tiền đã được ghi nhận.' : error.message });
    } finally {
      await session.endSession();
    }
  });

  // ----------------------- V6.4: chat + ratings + support + lost/found -----------------------
  router.get('/conversations', authenticate, async (req, res) => {
    try {
      const userId = req.v64.user._id;
      const docs = await getDb().collection('conversations').find({
        $or: [
          { participantUserIds: userId },
          { type: 'SUPPORT', ownerUserId: userId },
        ],
      }).sort({ updatedAt: -1 }).limit(100).toArray();
      const items = [];
      for (const doc of docs) items.push(await serializeConversation(doc, userId));
      return res.json(items);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/conversations/booking/:bookingId', authenticate, async (req, res) => {
    try {
      const db = getDb();
      const user = req.v64.user;
      const ctx = await participantContext(user, req.params.bookingId);
      if (!ctx) return res.status(403).json({ message: 'Bạn không thuộc chuyến này.' });
      if (!ctx.booking.driverId) return res.status(409).json({ message: 'Chuyến chưa có tài xế để nhắn tin.' });

      const driver = await db.collection('drivers').findOne({ _id: ctx.booking.driverId });
      if (!driver?.userId) return res.status(409).json({ message: 'Không tìm thấy tài khoản tài xế.' });

      const participants = [ctx.booking.customerId, driver.userId];
      let conversation = await db.collection('conversations').findOne({
        type: 'BOOKING',
        bookingId: ctx.booking._id,
        driverId: ctx.booking.driverId,
      });
      if (!conversation) {
        const now = new Date();
        const doc = {
          type: 'BOOKING',
          bookingId: ctx.booking._id,
          driverId: ctx.booking.driverId,
          participantUserIds: participants,
          title: `Chuyến ${ctx.booking.bookingCode || ''}`,
          readState: {},
          lastMessage: '',
          lastMessageAt: null,
          createdAt: now,
          updatedAt: now,
        };
        try {
          const result = await db.collection('conversations').insertOne(doc);
          conversation = { ...doc, _id: result.insertedId };
        } catch (error) {
          if (error?.code === 11000) {
            conversation = await db.collection('conversations').findOne({
              type: 'BOOKING',
              bookingId: ctx.booking._id,
              driverId: ctx.booking.driverId,
            });
          } else throw error;
        }
      } else {
        await db.collection('conversations').updateOne(
          { _id: conversation._id },
          { $set: { participantUserIds: participants, updatedAt: new Date() } },
        );
        conversation.participantUserIds = participants;
      }
      return res.json(await serializeConversation(conversation, user._id));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/conversations/support', authenticate, async (req, res) => {
    try {
      const db = getDb();
      const user = req.v64.user;
      let conversation = await db.collection('conversations').findOne({
        type: 'SUPPORT',
        ownerUserId: user._id,
        status: { $ne: 'CLOSED' },
      });
      if (!conversation) {
        const now = new Date();
        const doc = {
          type: 'SUPPORT',
          ownerUserId: user._id,
          participantUserIds: [user._id],
          title: 'TH79 iMove Support',
          status: 'OPEN',
          readState: {},
          lastMessage: '',
          lastMessageAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const result = await db.collection('conversations').insertOne(doc);
        conversation = { ...doc, _id: result.insertedId };

        const welcome = {
          conversationId: conversation._id,
          senderUserId: null,
          senderRole: 'SYSTEM',
          type: 'TEXT',
          text: 'TH79 iMove đã nhận cuộc trò chuyện. Bộ phận hỗ trợ sẽ phản hồi tại đây.',
          createdAt: now,
        };
        await db.collection('messages').insertOne(welcome);
        await db.collection('conversations').updateOne(
          { _id: conversation._id },
          { $set: { lastMessage: welcome.text, lastMessageAt: now, updatedAt: now } },
        );
        conversation.lastMessage = welcome.text;
        conversation.lastMessageAt = now;
      }
      return res.json(await serializeConversation(conversation, user._id));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  async function conversationForUser(conversationId, user) {
    const id = safeObjectId(conversationId);
    if (!id) return null;
    const conversation = await getDb().collection('conversations').findOne({ _id: id });
    if (!conversation) return null;
    const allowed = (
      Array.isArray(conversation.participantUserIds) &&
      conversation.participantUserIds.some((x) => String(x) === String(user._id))
    ) || (
        conversation.type === 'SUPPORT' &&
        String(conversation.ownerUserId) === String(user._id)
      );
    return allowed ? conversation : null;
  }

  router.get('/conversations/:id/messages', authenticate, async (req, res) => {
    try {
      const conversation = await conversationForUser(req.params.id, req.v64.user);
      if (!conversation) return res.status(403).json({ message: 'Bạn không có quyền xem cuộc trò chuyện này.' });
      const items = await getDb().collection('messages').find({
        conversationId: conversation._id,
      }).sort({ createdAt: 1 }).limit(300).toArray();
      return res.json(items.map(serializeMessage));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/conversations/:id/messages', authenticate, async (req, res) => {
    try {
      const db = getDb();
      const user = req.v64.user;
      const conversation = await conversationForUser(req.params.id, user);
      if (!conversation) return res.status(403).json({ message: 'Bạn không có quyền nhắn trong cuộc trò chuyện này.' });
      const text = cleanText(req.body?.text, config.messageMaxLength);
      if (!text) return res.status(400).json({ message: 'Tin nhắn không được để trống.' });
      const idempotencyKey = cleanText(
        req.headers['idempotency-key'] || req.body?.idempotencyKey,
        160,
      );
      if (idempotencyKey) {
        const existing = await db.collection('messages').findOne({
          conversationId: conversation._id,
          idempotencyKey,
        });
        if (existing) return res.json(serializeMessage(existing));
      }

      const doc = {
        conversationId: conversation._id,
        senderUserId: user._id,
        senderRole: hasRole(user, 'DRIVER') ? 'DRIVER' : (hasRole(user, 'MERCHANT') ? 'MERCHANT' : 'CUSTOMER'),
        type: 'TEXT',
        text,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        createdAt: new Date(),
      };
      const result = await db.collection('messages').insertOne(doc);
      doc._id = result.insertedId;
      await db.collection('conversations').updateOne(
        { _id: conversation._id },
        {
          $set: {
            lastMessage: text,
            lastMessageAt: doc.createdAt,
            updatedAt: doc.createdAt,
            [`readState.${String(user._id)}`]: doc.createdAt,
          },
        },
      );
      const payload = serializeMessage(doc);
      const targets = new Set(
        (conversation.participantUserIds || []).map((x) => String(x)),
      );
      if (conversation.ownerUserId) targets.add(String(conversation.ownerUserId));
      for (const id of targets) {
        try { getMatching()?.emitToUser?.(id, 'chat:new_message', payload); } catch (_) { }
      }
      return res.status(201).json(payload);
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({ code: 'MESSAGE_DUPLICATE', message: 'Tin nhắn đã được ghi nhận.' });
      }
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/conversations/:id/read', authenticate, async (req, res) => {
    try {
      const conversation = await conversationForUser(req.params.id, req.v64.user);
      if (!conversation) return res.status(403).json({ message: 'Bạn không có quyền xem cuộc trò chuyện này.' });
      await getDb().collection('conversations').updateOne(
        { _id: conversation._id },
        { $set: { [`readState.${String(req.v64.user._id)}`]: new Date() } },
      );
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/ratings', authenticate, async (req, res) => {
    try {
      const db = getDb();
      const user = req.v64.user;
      const ctx = await participantContext(user, req.body?.bookingId);
      if (!ctx) return res.status(403).json({ message: 'Bạn không thuộc chuyến này.' });
      if (ctx.booking.status !== 'COMPLETED') return res.status(409).json({ message: 'Chỉ đánh giá chuyến đã hoàn thành.' });

      const score = Math.round(number(req.body?.score));
      if (score < 1 || score > 5) return res.status(400).json({ message: 'Điểm đánh giá phải từ 1 đến 5.' });

      let toUserId = null;
      if (ctx.role === 'CUSTOMER') {
        const driver = ctx.booking.driverId
          ? await db.collection('drivers').findOne({ _id: ctx.booking.driverId })
          : null;
        toUserId = driver?.userId || null;
      } else {
        toUserId = ctx.booking.customerId;
      }
      if (!toUserId) return res.status(409).json({ message: 'Không xác định được người nhận đánh giá.' });

      const doc = {
        bookingId: ctx.booking._id,
        fromUserId: user._id,
        toUserId,
        score,
        comment: cleanText(req.body?.comment, 600),
        tags: Array.isArray(req.body?.tags) ? req.body.tags.map((x) => cleanText(x, 60)).filter(Boolean).slice(0, 10) : [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await db.collection('ratings').updateOne(
        { bookingId: doc.bookingId, fromUserId: doc.fromUserId },
        { $set: doc },
        { upsert: true },
      );

      if (ctx.role === 'CUSTOMER' && ctx.booking.driverId) {
        const ratings = await db.collection('ratings').aggregate([
          { $match: { toUserId } },
          { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } },
        ]).toArray();
        if (ratings[0]) {
          await db.collection('drivers').updateOne(
            { _id: ctx.booking.driverId },
            { $set: { rating: Number(ratings[0].average.toFixed(2)), ratingCount: ratings[0].count, updatedAt: new Date() } },
          );
        }
      }
      return res.json({ ok: true, score });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ message: 'Bạn đã đánh giá chuyến này.' });
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/support/tickets', authenticate, async (req, res) => {
    const items = await getDb().collection('support_tickets')
      .find({ userId: req.v64.user._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return res.json(items.map((x) => ({
      id: String(x._id),
      code: x.code,
      category: x.category,
      subject: x.subject,
      message: x.message,
      status: x.status,
      bookingId: x.bookingId ? String(x.bookingId) : null,
      createdAt: iso(x.createdAt),
      updatedAt: iso(x.updatedAt),
    })));
  });

  router.post('/support/tickets', authenticate, async (req, res) => {
    try {
      const category = cleanText(req.body?.category, 60) || 'OTHER';
      const subject = cleanText(req.body?.subject, 160);
      const message = cleanText(req.body?.message, 1500);
      if (!subject || !message) return res.status(400).json({ message: 'Vui lòng nhập tiêu đề và nội dung.' });
      let bookingId = null;
      if (req.body?.bookingId) {
        const ctx = await participantContext(req.v64.user, req.body.bookingId);
        if (!ctx) return res.status(403).json({ message: 'Bạn không thuộc chuyến đã chọn.' });
        bookingId = ctx.booking._id;
      }
      const now = new Date();
      const doc = {
        code: `SP${Date.now()}`,
        userId: req.v64.user._id,
        category,
        subject,
        message,
        bookingId,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
      };
      const result = await getDb().collection('support_tickets').insertOne(doc);
      await notifyUser(req.v64.user._id, {
        type: 'SUPPORT',
        title: 'Đã tiếp nhận yêu cầu hỗ trợ',
        body: `${doc.code} - ${subject}`,
        bookingId,
      });
      return res.status(201).json({ id: String(result.insertedId), code: doc.code, status: doc.status });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/lost-found', authenticate, async (req, res) => {
    try {
      const ctx = await participantContext(req.v64.user, req.body?.bookingId);
      if (!ctx) return res.status(403).json({ message: 'Bạn không thuộc chuyến này.' });
      const description = cleanText(req.body?.description, 1200);
      if (!description) return res.status(400).json({ message: 'Vui lòng mô tả đồ thất lạc.' });
      const doc = {
        userId: req.v64.user._id,
        bookingId: ctx.booking._id,
        description,
        contactPhone: cleanText(req.body?.contactPhone || req.v64.user.phone, 30),
        status: 'OPEN',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await getDb().collection('lost_found_reports').insertOne(doc);
      return res.status(201).json({ id: String(result.insertedId), status: 'OPEN' });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/platform/config', (_req, res) => {
    res.json({
      version: '6.6.1',
      features: {
        realtimeRideRecovery: true,
        sequentialMatching: true,
        liveDriverLocation: true,
        inAppNotifications: true,
        fcmDeviceRegistration: true,
        safetySos: true,
        safetyShare: true,
        walletLedger: true,
        demoTopup: config.demoTopupEnabled,
        driverFinance: true,
        autoDriverSettlement: true,
        withdrawalRequests: true,
        inAppChat: true,
        ratings: true,
        supportTickets: true,
        lostAndFound: true,
      },
      integrations: {
        firebasePush: 'READY_REQUIRES_CREDENTIALS',
        momo: 'ADAPTER_NOT_CONFIGURED',
        vnpay: 'ADAPTER_NOT_CONFIGURED',
      },
    });
  });

  return { router, databaseReady, notifyUser, settleCompletedBooking, reconcileCompletedBookingSettlement, completeBookingTransaction };
}

module.exports = { createPlatformService };
