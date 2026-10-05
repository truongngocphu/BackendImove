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
      return res.status(429).json({
        message: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau.',
      });
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

  async function requireAdmin(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Thiếu Access Token.' });
      }

      const token = header.slice(7).trim();
      const payload = jwt.verify(token, jwtSecret());
      const userId = safeObjectId(payload.sub || payload.userId);

      if (!userId) {
        return res.status(401).json({ message: 'Access Token không hợp lệ.' });
      }

      const db = getDb();
      if (!db) {
        return res.status(503).json({ message: 'Database chưa sẵn sàng.' });
      }

      const user = await db.collection('users').findOne({
        _id: userId,
        roles: 'ADMIN',
      });

      if (!user) {
        return res.status(403).json({ message: 'Tài khoản không có quyền ADMIN.' });
      }

      const status = String(user.status || 'ACTIVE').toUpperCase();
      if (['BLOCKED', 'DISABLED', 'DELETED', 'INACTIVE'].includes(status)) {
        return res.status(403).json({ message: 'Tài khoản quản trị đã bị khóa.' });
      }

      req.admin = user;
      next();
    } catch (_) {
      return res.status(401).json({
        message: 'Phiên quản trị không hợp lệ hoặc đã hết hạn.',
      });
    }
  }

  router.post('/login', checkRate, async (req, res) => {
    try {
      const db = getDb();
      if (!db) {
        return res.status(503).json({ message: 'Database chưa sẵn sàng.' });
      }

      const login = String(
        req.body?.login ||
        req.body?.phone ||
        req.body?.email ||
        ''
      ).trim();

      const password = String(req.body?.password || '');

      if (!login || !password) {
        return res.status(400).json({
          message: 'Vui lòng nhập tài khoản và mật khẩu.',
        });
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
        return res.status(401).json({
          message: 'Tài khoản hoặc mật khẩu không đúng.',
        });
      }

      const status = String(user.status || 'ACTIVE').toUpperCase();
      if (['BLOCKED', 'DISABLED', 'DELETED', 'INACTIVE'].includes(status)) {
        return res.status(403).json({
          message: 'Tài khoản quản trị đã bị khóa.',
        });
      }

      const ok = await bcrypt.compare(password, user.passwordHash);

      if (!ok) {
        noteFailure(req);
        return res.status(401).json({
          message: 'Tài khoản hoặc mật khẩu không đúng.',
        });
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
        accessToken,
        expiresInSeconds: hours * 60 * 60,
        user: publicAdmin(user),
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/me', requireAdmin, async (req, res) => {
    return res.json({ user: publicAdmin(req.admin) });
  });

  return router;
}

module.exports = { createAdminAuthRouter };