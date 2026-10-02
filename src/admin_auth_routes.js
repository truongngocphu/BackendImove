const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

function jwtSecret() {
  const secret = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (secret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET chưa được cấu hình an toàn.');
  }
  return secret;
}

function safeObjectId(value) {
  try {
    return new ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

function publicAdmin(user) {
  return {
    id: String(user._id),
    fullName: user.fullName || 'Quản trị viên',
    phone: user.phone || null,
    email: user.email || null,
    roles: Array.isArray(user.roles) ? user.roles : [],
    status: user.status || 'ACTIVE',
  };
}

function errorPayload(req, code, message, details = null) {
  return {
    ok: false,
    success: false,
    code,
    message,
    requestId: req?.requestId || null,
    ...(details ? { details } : {}),
  };
}

function createAdminAuthRouter({ getDb }) {
  const router = express.Router();

  // Basic in-memory brute-force protection for development/local deployment.
  // Production should move rate limiting to Redis/reverse proxy.
  const attempts = new Map();
  const windowMs = 10 * 60 * 1000;
  const maxAttempts = 8;

  function clientKey(req) {
    return String(
      req.headers['x-forwarded-for'] ||
      req.socket?.remoteAddress ||
      'unknown'
    ).split(',')[0].trim();
  }

  function checkRate(req, res, next) {
    const key = clientKey(req);
    const now = Date.now();
    const current = attempts.get(key);

    if (!current || now - current.startedAt > windowMs) {
      attempts.set(key, { startedAt: now, count: 0 });
      return next();
    }

    if (current.count >= maxAttempts) {
      return res.status(429).json(errorPayload(req, 'ADMIN_LOGIN_RATE_LIMITED', 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau.'));
    }

    next();
  }

  function noteFailure(req) {
    const key = clientKey(req);
    const now = Date.now();
    const current = attempts.get(key);

    if (!current || now - current.startedAt > windowMs) {
      attempts.set(key, { startedAt: now, count: 1 });
    } else {
      current.count += 1;
      attempts.set(key, current);
    }
  }

  function clearFailures(req) {
    attempts.delete(clientKey(req));
  }

  // Public compatibility health. The Admin login page can call this before it has a token.
  router.get('/health', async (req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(503).json(errorPayload(req, 'DATABASE_NOT_READY', 'Core Backend đang chạy nhưng database chưa sẵn sàng.'));
      const started = Date.now();
      const pong = await db.command({ ping: 1 });
      const ok = pong?.ok === 1;
      return res.status(ok ? 200 : 503).json({
        ok,
        success: ok,
        ready: ok,
        backend: true,
        coreBackend: true,
        database: ok,
        service: 'TH79_IMOVE_CORE',
        component: 'ADMIN_AUTH',
        latencyMs: Date.now() - started,
        requestId: req.requestId || null,
      });
    } catch (error) {
      console.error('[ADMIN_AUTH_HEALTH]', error);
      return res.status(503).json(errorPayload(req, 'ADMIN_AUTH_HEALTH_FAILED', error.message));
    }
  });

  async function requireAdmin(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) {
        return res.status(401).json(errorPayload(req, 'ADMIN_TOKEN_MISSING', 'Thiếu Access Token.'));
      }

      const token = header.slice(7).trim();
      const payload = jwt.verify(token, jwtSecret());
      const userId = safeObjectId(payload.sub || payload.userId);

      if (!userId) {
        return res.status(401).json(errorPayload(req, 'ADMIN_TOKEN_INVALID', 'Access Token không hợp lệ.'));
      }

      const db = getDb();
      if (!db) {
        return res.status(503).json(errorPayload(req, 'DATABASE_NOT_READY', 'Database chưa sẵn sàng.', { action: 'Kiểm tra /health và kết nối MongoDB Atlas.' }));
      }

      const user = await db.collection('users').findOne({
        _id: userId,
        roles: 'ADMIN',
      });

      if (!user) {
        return res.status(403).json(errorPayload(req, 'ADMIN_PERMISSION_REQUIRED', 'Tài khoản không có quyền ADMIN.'));
      }

      const status = String(user.status || 'ACTIVE').toUpperCase();
      if (['BLOCKED', 'DISABLED', 'DELETED', 'INACTIVE'].includes(status)) {
        return res.status(403).json(errorPayload(req, 'ADMIN_ACCOUNT_DISABLED', 'Tài khoản quản trị đã bị khóa.'));
      }

      req.admin = user;
      next();
    } catch (_) {
      return res.status(401).json(errorPayload(req, 'ADMIN_SESSION_INVALID', 'Phiên quản trị không hợp lệ hoặc đã hết hạn.'));
    }
  }

  router.post('/login', checkRate, async (req, res) => {
    try {
      const db = getDb();
      if (!db) {
        return res.status(503).json(errorPayload(req, 'DATABASE_NOT_READY', 'Database chưa sẵn sàng.', { action: 'Kiểm tra /health và kết nối MongoDB Atlas.' }));
      }

      const login = String(
        req.body?.login ||
        req.body?.phone ||
        req.body?.email ||
        ''
      ).trim();

      const password = String(req.body?.password || '');

      if (!login || !password) {
        return res.status(400).json(errorPayload(req, 'ADMIN_CREDENTIALS_REQUIRED', 'Vui lòng nhập tài khoản và mật khẩu.'));
      }

      const email = login.toLowerCase();

      const user = await db.collection('users').findOne({
        roles: 'ADMIN',
        $or: [
          { phone: login },
          { email },
        ],
      });

      if (!user || !user.passwordHash) {
        noteFailure(req);
        return res.status(401).json(errorPayload(req, 'ADMIN_CREDENTIALS_INVALID', 'Tài khoản hoặc mật khẩu không đúng.'));
      }

      const status = String(user.status || 'ACTIVE').toUpperCase();
      if (['BLOCKED', 'DISABLED', 'DELETED', 'INACTIVE'].includes(status)) {
        return res.status(403).json(errorPayload(req, 'ADMIN_ACCOUNT_DISABLED', 'Tài khoản quản trị đã bị khóa.'));
      }

      const ok = await bcrypt.compare(password, user.passwordHash);

      if (!ok) {
        noteFailure(req);
        return res.status(401).json(errorPayload(req, 'ADMIN_CREDENTIALS_INVALID', 'Tài khoản hoặc mật khẩu không đúng.'));
      }

      clearFailures(req);

      const hours = Math.max(
        1,
        Math.min(12, Number(process.env.ADMIN_AUTH_SESSION_HOURS || 8))
      );

      const accessToken = jwt.sign(
        {
          sub: String(user._id),
          typ: 'ADMIN_WEB',
        },
        jwtSecret(),
        { expiresIn: `${hours}h` }
      );

      return res.json({
        ok: true,
        success: true,
        accessToken,
        expiresInSeconds: hours * 60 * 60,
        user: publicAdmin(user),
        requestId: req.requestId || null,
      });
    } catch (error) {
      console.error('[ADMIN_AUTH_LOGIN]', error);
      return res.status(500).json(errorPayload(req, error.code || 'ADMIN_LOGIN_FAILED', error.message || 'Đăng nhập Admin thất bại.'));
    }
  });

  router.get('/me', requireAdmin, async (req, res) => {
    return res.json({ ok: true, success: true, user: publicAdmin(req.admin), requestId: req.requestId || null });
  });

  return router;
}

module.exports = { createAdminAuthRouter };