const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  override: true,
});
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendOtpSms, assertOtpThrottle } = require('./otp_delivery_service');
const { ObjectId } = require('mongodb');

const router = express.Router();

const JWT_ACCESS_SECRET =
  String(process.env.JWT_ACCESS_SECRET || '');

const ACCESS_TTL_SECONDS =
  Math.max(
    300,
    Number(
      process.env.JWT_ACCESS_TTL_SECONDS ||
      900,
    ),
  );

const REFRESH_DAYS =
  Math.max(
    1,
    Number(
      process.env.AUTH_REFRESH_DAYS ||
      30,
    ),
  );

const OTP_MINUTES =
  Math.max(
    1,
    Number(
      process.env.AUTH_OTP_MINUTES ||
      5,
    ),
  );

const DEV_SHOW_OTP =
  String(
    process.env.AUTH_DEV_SHOW_OTP ||
    'false',
  ).toLowerCase() === 'true';

const now = () => new Date();

function normalizePhone(value) {
  return String(value || '')
    .replace(/\D/g, '')
    .trim();
}

function validatePhone(phone) {
  return /^0\d{9}$/.test(phone);
}

function normalizeEmail(value) {
  const email =
    String(value || '')
      .trim()
      .toLowerCase();

  return email || null;
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');
}

function randomRefreshToken() {
  return crypto
    .randomBytes(64)
    .toString('hex');
}

function generateOtp() {
  return String(
    crypto.randomInt(
      100000,
      1000000,
    ),
  );
}

function publicUser(user) {
  return {
    id: String(user._id),

    phone:
      user.phone,

    fullName:
      user.fullName,

    email:
      user.email || null,

    avatarUrl:
      user.avatarUrl || null,

    status:
      user.status,

    roles:
      Array.isArray(user.roles)
        ? user.roles
        : [],
  };
}

function ensureSecret() {
  if (
    !JWT_ACCESS_SECRET ||
    JWT_ACCESS_SECRET.length < 32
  ) {
    throw new Error(
      'JWT_ACCESS_SECRET chưa được cấu hình an toàn trong .env.',
    );
  }
}

function createAccessToken(user) {
  ensureSecret();

  return jwt.sign(
    {
      phone:
        user.phone,

      roles:
        Array.isArray(user.roles)
          ? user.roles
          : [],
    },

    JWT_ACCESS_SECRET,

    {
      subject:
        String(user._id),

      issuer:
        'th79-imove',

      audience:
        'th79-imove-apps',

      expiresIn:
        ACCESS_TTL_SECONDS,
    },
  );
}

async function ensureIndexes(db) {
  try {
    await db
      .collection('users')
      .createIndex(
        {
          phone: 1,
        },
        {
          unique: true,
        },
      );

    await db
      .collection('auth_sessions')
      .createIndex(
        {
          tokenHash: 1,
        },
        {
          unique: true,
        },
      );

    await db
      .collection('auth_sessions')
      .createIndex({
        userId: 1,
        revokedAt: 1,
      });

    await db
      .collection('auth_sessions')
      .createIndex(
        {
          expiresAt: 1,
        },
        {
          expireAfterSeconds: 0,
        },
      );

    await db
      .collection('otp_verifications')
      .createIndex({
        phone: 1,
        purpose: 1,
        createdAt: -1,
      });

    await db
      .collection('otp_verifications')
      .createIndex(
        {
          expiresAt: 1,
        },
        {
          expireAfterSeconds: 0,
        },
      );
  } catch (error) {
    console.warn(
      '[AUTH INDEX]',
      error.message,
    );
  }
}

async function issueTokens({
  db,
  user,
  req,
}) {
  const accessToken =
    createAccessToken(user);

  const refreshToken =
    randomRefreshToken();

  const tokenHash =
    sha256(refreshToken);

  const createdAt =
    now();

  const expiresAt =
    new Date(
      Date.now() +
      REFRESH_DAYS *
      24 *
      60 *
      60 *
      1000,
    );

  await db
    .collection('auth_sessions')
    .insertOne({
      userId:
        user._id,

      tokenHash,

      userAgent:
        String(
          req.headers[
            'user-agent'
          ] || '',
        ),

      ip:
        req.ip || null,

      createdAt,

      lastUsedAt:
        createdAt,

      expiresAt,

      revokedAt:
        null,
    });

  return {
    accessToken,

    refreshToken,

    tokenType:
      'Bearer',

    expiresIn:
      ACCESS_TTL_SECONDS,

    refreshExpiresAt:
      expiresAt.toISOString(),
  };
}

function createAuthenticate(
  getDb,
) {
  return async function authenticate(
    req,
    res,
    next,
  ) {
    try {
      ensureSecret();

      const header =
        String(
          req.headers.authorization ||
          '',
        );

      if (
        !header.startsWith(
          'Bearer ',
        )
      ) {
        return res
          .status(401)
          .json({
            message:
              'Thiếu Access Token.',
          });
      }

      const token =
        header.substring(7);

      const payload =
        jwt.verify(
          token,
          JWT_ACCESS_SECRET,
          {
            issuer:
              'th79-imove',

            audience:
              'th79-imove-apps',
          },
        );

      const userId =
        new ObjectId(
          payload.sub,
        );

      const db =
        getDb();

      if (!db) {
        return res
          .status(503)
          .json({
            message:
              'Database chưa sẵn sàng.',
          });
      }

      const user =
        await db
          .collection('users')
          .findOne({
            _id:
              userId,

            status:
              'ACTIVE',
          });

      if (!user) {
        return res
          .status(401)
          .json({
            message:
              'Tài khoản không tồn tại hoặc đã bị khóa.',
          });
      }

      req.auth = {
        user,
        payload,
      };

      return next();
    } catch (error) {
      if (
        error.name ===
        'TokenExpiredError'
      ) {
        return res
          .status(401)
          .json({
            code:
              'TOKEN_EXPIRED',

            message:
              'Phiên đăng nhập đã hết hạn.',
          });
      }

      return res
        .status(401)
        .json({
          code:
            'INVALID_TOKEN',

          message:
            'Access Token không hợp lệ.',
        });
    }
  };
}

function createAuthRouter({
  getDb,
}) {
  const authenticate =
    createAuthenticate(
      getDb,
    );

  router.use(
    async (
      req,
      res,
      next,
    ) => {
      const db =
        getDb();

      if (!db) {
        return res
          .status(503)
          .json({
            message:
              'MongoDB Atlas chưa sẵn sàng.',
          });
      }

      await ensureIndexes(
        db,
      );

      next();
    },
  );

  // ============================================
  // CUSTOMER REGISTER
  // ============================================

  router.post(
    '/register',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const fullName =
          String(
            req.body
              ?.fullName ||
            '',
          ).trim();

        const phone =
          normalizePhone(
            req.body
              ?.phone,
          );

        const email =
          normalizeEmail(
            req.body
              ?.email,
          );

        const password =
          String(
            req.body
              ?.password ||
            '',
          );

        if (
          fullName.length < 2
        ) {
          return res
            .status(400)
            .json({
              message:
                'Họ tên không hợp lệ.',
            });
        }

        if (
          !validatePhone(
            phone,
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                'Số điện thoại phải gồm 10 số và bắt đầu bằng 0.',
            });
        }

        if (
          password.length < 6
        ) {
          return res
            .status(400)
            .json({
              message:
                'Mật khẩu phải có ít nhất 6 ký tự.',
            });
        }

        const verificationToken = String(req.body?.verificationToken || '').trim();
        const requireOtp = String(process.env.CUSTOMER_REGISTER_REQUIRE_OTP || 'true').toLowerCase() !== 'false';
        if (requireOtp) {
          if (!verificationToken) {
            return res.status(400).json({ code: 'OTP_REQUIRED', message: 'Vui lòng xác thực OTP số điện thoại trước khi đăng ký.' });
          }
          try {
            ensureSecret();
            const verified = jwt.verify(verificationToken, JWT_ACCESS_SECRET, {
              issuer: 'th79-imove',
              audience: 'th79-imove-apps',
            });
            if (verified?.kind !== 'OTP_VERIFICATION' || normalizePhone(verified?.phone) !== phone || !['CUSTOMER_PHONE_VERIFY','PHONE_VERIFY'].includes(String(verified?.purpose || '').toUpperCase())) {
              return res.status(400).json({ code: 'OTP_INVALID', message: 'Phiên xác thực OTP không hợp lệ.' });
            }
          } catch (_) {
            return res.status(400).json({ code: 'OTP_EXPIRED', message: 'Phiên xác thực OTP đã hết hạn. Vui lòng gửi lại mã.' });
          }
        }

        let user =
          await db
            .collection('users')
            .findOne({
              phone,
            });

        // Nếu booking trước đây đã tự tạo user
        // passwordHash = null,
        // cho phép khách hàng nhận lại tài khoản.
        if (
          user &&
          user.passwordHash
        ) {
          return res
            .status(409)
            .json({
              message:
                'Số điện thoại này đã có tài khoản.',
            });
        }

        const passwordHash =
          await bcrypt.hash(
            password,
            12,
          );

        const changedAt =
          now();

        if (user) {
          await db
            .collection('users')
            .updateOne(
              {
                _id:
                  user._id,
              },
              {
                $set: {
                  fullName,
                  email,
                  passwordHash,

                  status:
                    'ACTIVE',

                  updatedAt:
                    changedAt,
                },

                $addToSet: {
                  roles:
                    'CUSTOMER',
                },
              },
            );

          user =
            await db
              .collection('users')
              .findOne({
                _id:
                  user._id,
              });
        } else {
          const doc = {
            phone,
            fullName,
            email,

            passwordHash,

            avatarUrl:
              null,

            status:
              'ACTIVE',

            roles: [
              'CUSTOMER',
            ],

            lastLoginAt:
              changedAt,

            createdAt:
              changedAt,

            updatedAt:
              changedAt,
          };

          const result =
            await db
              .collection('users')
              .insertOne(
                doc,
              );

          user = {
            ...doc,

            _id:
              result.insertedId,
          };
        }

        const tokens =
          await issueTokens({
            db,
            user,
            req,
          });

        return res
          .status(201)
          .json({
            user:
              publicUser(
                user,
              ),

            ...tokens,
          });
      } catch (error) {
        console.error(
          '[AUTH REGISTER]',
          error,
        );

        if (
          error.code ===
          11000
        ) {
          return res
            .status(409)
            .json({
              message:
                'Số điện thoại này đã tồn tại.',
            });
        }

        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // LOGIN CUSTOMER / DRIVER
  // ============================================

  router.post(
    '/login',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const phone =
          normalizePhone(
            req.body
              ?.phone,
          );

        const password =
          String(
            req.body
              ?.password ||
            '',
          );

        const requestedRole =
          String(
            req.body
              ?.role ||
            '',
          )
            .trim()
            .toUpperCase();

        const user =
          await db
            .collection('users')
            .findOne({
              phone,
            });

        if (
          !user ||
          !user.passwordHash
        ) {
          return res
            .status(401)
            .json({
              message:
                'Số điện thoại hoặc mật khẩu không đúng.',
            });
        }

        if (
          user.status !==
          'ACTIVE'
        ) {
          return res
            .status(403)
            .json({
              message:
                'Tài khoản đang bị khóa.',
            });
        }

        const passwordOk =
          await bcrypt.compare(
            password,
            user.passwordHash,
          );

        if (!passwordOk) {
          return res
            .status(401)
            .json({
              message:
                'Số điện thoại hoặc mật khẩu không đúng.',
            });
        }

        const roles =
          Array.isArray(
            user.roles,
          )
            ? user.roles
            : [];

        if (
          requestedRole &&
          !roles.includes(
            requestedRole,
          )
        ) {
          return res
            .status(403)
            .json({
              message:
                `Tài khoản không có quyền ${requestedRole}.`,
            });
        }

        let driver = null;
        let vehicle = null;

        if (
          roles.includes(
            'DRIVER',
          )
        ) {
          driver =
            await db
              .collection('drivers')
              .findOne({
                userId:
                  user._id,
              });

          if (driver) {
            vehicle =
              await db
                .collection('vehicles')
                .findOne({
                  driverId:
                    driver._id,
                });
          }
        }

        await db
          .collection('users')
          .updateOne(
            {
              _id:
                user._id,
            },
            {
              $set: {
                lastLoginAt:
                  now(),

                updatedAt:
                  now(),
              },
            },
          );

        const tokens =
          await issueTokens({
            db,
            user,
            req,
          });

        return res.json({
          user:
            publicUser(
              user,
            ),

          driver:
            driver
              ? {
                  id:
                    String(
                      driver._id,
                    ),

                  approvalStatus:
                    driver.approvalStatus,

                  onlineStatus:
                    driver.onlineStatus,

                  rating:
                    Number(
                      driver.rating ||
                      0,
                    ),
                }
              : null,

          vehicle:
            vehicle
              ? {
                  id:
                    String(
                      vehicle._id,
                    ),

                  plateNumber:
                    vehicle.plateNumber,

                  brand:
                    vehicle.brand,

                  model:
                    vehicle.model,

                  color:
                    vehicle.color,

                  status:
                    vehicle.status,
                }
              : null,

          ...tokens,
        });
      } catch (error) {
        console.error(
          '[AUTH LOGIN]',
          error,
        );

        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );


  // ============================================
  // GENERIC PHONE OTP (non-breaking v1.7.1)
  // ============================================

  router.post('/otp/request', async (req, res) => {
    try {
      const db = getDb();
      const phone = normalizePhone(req.body?.phone);
      const purpose = String(req.body?.purpose || 'PHONE_VERIFY').trim().toUpperCase();
      const allowed = new Set([
        'PHONE_VERIFY',
        'CUSTOMER_PHONE_VERIFY',
        'MERCHANT_PHONE_VERIFY',
        'PASSWORD_RESET',
      ]);
      if (!validatePhone(phone)) {
        return res.status(400).json({ message: 'Số điện thoại không hợp lệ.' });
      }
      if (!allowed.has(purpose)) {
        return res.status(400).json({ message: 'Mục đích OTP không hợp lệ.' });
      }
      await assertOtpThrottle(db, { phone, purpose });
      const otp = generateOtp();
      const createdAt = now();
      const expiresAt = new Date(Date.now() + OTP_MINUTES * 60 * 1000);
      await db.collection('otp_verifications').insertOne({
        phone,
        purpose,
        codeHash: sha256(otp),
        createdAt,
        expiresAt,
        usedAt: null,
      });
      const delivery = await sendOtpSms({ phone, otp, purpose });
      const response = {
        ok: true,
        delivered: Boolean(delivery?.delivered),
        message: `OTP có hiệu lực ${OTP_MINUTES} phút.`,
        expiresAt: expiresAt.toISOString(),
      };
      if (DEV_SHOW_OTP) response.devOtp = otp;
      return res.json(response);
    } catch (error) {
      if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      return res.status(Number(error?.httpStatus) || 503).json({ message: error.message });
    }
  });

  router.post('/otp/verify', async (req, res) => {
    try {
      const db = getDb();
      const phone = normalizePhone(req.body?.phone);
      const purpose = String(req.body?.purpose || 'PHONE_VERIFY').trim().toUpperCase();
      const code = String(req.body?.otpCode || '').trim();
      if (!validatePhone(phone) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ message: 'OTP hoặc số điện thoại không hợp lệ.' });
      }
      const record = await db.collection('otp_verifications').findOne({
        phone,
        purpose,
        codeHash: sha256(code),
        usedAt: null,
        expiresAt: { $gt: now() },
      }, { sort: { createdAt: -1 } });
      if (!record) return res.status(400).json({ message: 'OTP không đúng hoặc đã hết hạn.' });
      await db.collection('otp_verifications').updateOne(
        { _id: record._id, usedAt: null },
        { $set: { usedAt: now() } },
      );
      ensureSecret();
      const verificationToken = jwt.sign(
        { phone, purpose, kind: 'OTP_VERIFICATION' },
        JWT_ACCESS_SECRET,
        {
          issuer: 'th79-imove',
          audience: 'th79-imove-apps',
          expiresIn: 10 * 60,
        },
      );
      return res.json({ ok: true, phone, purpose, verificationToken, expiresIn: 600 });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  // ============================================
  // DRIVER REQUEST OTP
  // ============================================

  router.post(
    '/driver/request-otp',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const phone =
          normalizePhone(
            req.body
              ?.phone,
          );

        if (
          !validatePhone(
            phone,
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                'Số điện thoại không hợp lệ.',
            });
        }

        const user =
          await db
            .collection('users')
            .findOne({
              phone,
            });

        if (
          user &&
          user.passwordHash &&
          Array.isArray(
            user.roles,
          ) &&
          user.roles.includes(
            'DRIVER',
          )
        ) {
          return res
            .status(409)
            .json({
              message:
                'Tài khoản tài xế này đã được đăng ký.',
            });
        }

        await assertOtpThrottle(db, { phone, purpose: 'DRIVER_REGISTER' });

        const otp =
          generateOtp();

        const createdAt =
          now();

        const expiresAt =
          new Date(
            Date.now() +
            OTP_MINUTES *
            60 *
            1000,
          );

        await db
          .collection(
            'otp_verifications',
          )
          .insertOne({
            phone,

            purpose:
              'DRIVER_REGISTER',

            codeHash:
              sha256(
                otp,
              ),

            createdAt,

            expiresAt,

            usedAt:
              null,
          });

        const delivery = await sendOtpSms({
          phone,
          otp,
          purpose: 'DRIVER_REGISTER',
        });

        const response = {
          ok: true,
          delivered: Boolean(delivery?.delivered),

          message:
            `OTP có hiệu lực ${OTP_MINUTES} phút.`,

          expiresAt:
            expiresAt.toISOString(),
        };

        // Chỉ dùng lúc DEV.
        // Production phải gửi OTP qua SMS.
        if (
          DEV_SHOW_OTP
        ) {
          response.devOtp =
            otp;
        }

        return res.json(
          response,
        );
      } catch (error) {
        if (error?.retryAfter) {
          res.setHeader('Retry-After', String(error.retryAfter));
        }
        return res
          .status(Number(error?.httpStatus) || 503)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // DRIVER REGISTER WITH OTP
  // ============================================

  router.post(
    '/driver/register',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const fullName =
          String(
            req.body
              ?.fullName ||
            '',
          ).trim();

        const phone =
          normalizePhone(
            req.body
              ?.phone,
          );

        const email =
          normalizeEmail(
            req.body
              ?.email,
          );

        const password =
          String(
            req.body
              ?.password ||
            '',
          );

        const otpCode =
          String(
            req.body
              ?.otpCode ||
            '',
          ).trim();

        const vehicleType = String(req.body?.vehicleType || 'MOTORBIKE').trim().toUpperCase();
        const requestedServiceCodes = Array.isArray(req.body?.requestedServiceCodes)
          ? [...new Set(req.body.requestedServiceCodes.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))]
          : [];
        const allowedVehicleTypes = new Set(['MOTORBIKE','CAR_4','CAR_7','MPV_7','LUXURY','VAN','TRUCK']);
        const motorbikeServices = new Set(['BIKE','FOOD','ERRAND','DELIVERY']);
        if (!allowedVehicleTypes.has(vehicleType)) {
          return res.status(400).json({ message: 'Loại phương tiện không hợp lệ.' });
        }
        if (vehicleType === 'MOTORBIKE') {
          const invalid = requestedServiceCodes.find((code) => !motorbikeServices.has(code));
          if (invalid || requestedServiceCodes.length === 0) {
            return res.status(400).json({ message: 'Xe máy phải chọn ít nhất một dịch vụ BIKE/FOOD/MARKET/DELIVERY.' });
          }
        }

        if (
          fullName.length < 2 ||
          !validatePhone(
            phone,
          ) ||
          password.length < 6 ||
          !/^\d{6}$/.test(
            otpCode,
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                'Thông tin đăng ký tài xế không hợp lệ.',
            });
        }

        const otp =
          await db
            .collection(
              'otp_verifications',
            )
            .findOne(
              {
                phone,

                purpose:
                  'DRIVER_REGISTER',

                codeHash:
                  sha256(
                    otpCode,
                  ),

                usedAt:
                  null,

                expiresAt: {
                  $gt:
                    now(),
                },
              },
              {
                sort: {
                  createdAt:
                    -1,
                },
              },
            );

        if (!otp) {
          return res
            .status(400)
            .json({
              message:
                'OTP không đúng hoặc đã hết hạn.',
            });
        }

        let user =
          await db
            .collection('users')
            .findOne({
              phone,
            });

        if (
          user &&
          user.passwordHash
        ) {
          return res
            .status(409)
            .json({
              message:
                'Số điện thoại này đã có tài khoản.',
            });
        }

        const passwordHash =
          await bcrypt.hash(
            password,
            12,
          );

        const changedAt =
          now();

        if (user) {
          await db
            .collection('users')
            .updateOne(
              {
                _id:
                  user._id,
              },
              {
                $set: {
                  fullName,
                  email,
                  passwordHash,

                  status:
                    'ACTIVE',

                  updatedAt:
                    changedAt,
                },

                $addToSet: {
                  roles:
                    'DRIVER',
                },
              },
            );

          user =
            await db
              .collection('users')
              .findOne({
                _id:
                  user._id,
              });
        } else {
          const doc = {
            phone,
            fullName,
            email,

            passwordHash,

            avatarUrl:
              null,

            status:
              'ACTIVE',

            roles: [
              'DRIVER',
            ],

            lastLoginAt:
              null,

            createdAt:
              changedAt,

            updatedAt:
              changedAt,
          };

          const result =
            await db
              .collection('users')
              .insertOne(
                doc,
              );

          user = {
            ...doc,

            _id:
              result.insertedId,
          };
        }

        let driver =
          await db
            .collection('drivers')
            .findOne({
              userId:
                user._id,
            });

        // Driver Demo đã có driver APPROVED:
        // giữ nguyên.
        // Driver mới => PENDING.
        if (!driver) {
          const driverDoc = {
            userId:
              user._id,

            approvalStatus:
              'PENDING',

            onlineStatus:
              'OFFLINE',

            vehicleType,
            requestedServiceCodes,
            approvedServiceCodes: [],
            serviceCapabilities: [],
            servicePreferences: Object.fromEntries(
              requestedServiceCodes.map((code) => [code, false]),
            ),

            rating:
              5,

            completedTrips:
              0,

            cancelledTrips:
              0,

            acceptanceRate:
              100,

            approvedAt:
              null,

            createdAt:
              changedAt,

            updatedAt:
              changedAt,
          };

          const result =
            await db
              .collection('drivers')
              .insertOne(
                driverDoc,
              );

          driver = {
            ...driverDoc,

            _id:
              result.insertedId,
          };
        }

        await db
          .collection(
            'otp_verifications',
          )
          .updateOne(
            {
              _id:
                otp._id,
            },
            {
              $set: {
                usedAt:
                  changedAt,
              },
            },
          );

        const tokens =
          await issueTokens({
            db,
            user,
            req,
          });

        return res
          .status(201)
          .json({
            user:
              publicUser(
                user,
              ),

            driver: {
              id:
                String(
                  driver._id,
                ),

              approvalStatus:
                driver.approvalStatus,

              onlineStatus:
                driver.onlineStatus,

              rating:
                Number(
                  driver.rating ||
                  0,
                ),
            },

            ...tokens,
          });
      } catch (error) {
        console.error(
          '[DRIVER REGISTER]',
          error,
        );

        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // REFRESH TOKEN
  // ============================================

  router.post(
    '/refresh',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const refreshToken =
          String(
            req.body
              ?.refreshToken ||
            '',
          );

        if (
          refreshToken.length < 40
        ) {
          return res
            .status(401)
            .json({
              message:
                'Refresh Token không hợp lệ.',
            });
        }

        const tokenHash =
          sha256(
            refreshToken,
          );

        const session =
          await db
            .collection(
              'auth_sessions',
            )
            .findOne({
              tokenHash,

              revokedAt:
                null,

              expiresAt: {
                $gt:
                  now(),
              },
            });

        if (!session) {
          return res
            .status(401)
            .json({
              message:
                'Phiên đăng nhập đã hết hạn.',
            });
        }

        const user =
          await db
            .collection('users')
            .findOne({
              _id:
                session.userId,

              status:
                'ACTIVE',
            });

        if (!user) {
          return res
            .status(401)
            .json({
              message:
                'Tài khoản không còn hoạt động.',
            });
        }

        // Rotate refresh token:
        // token cũ không dùng lại được.
        await db
          .collection(
            'auth_sessions',
          )
          .updateOne(
            {
              _id:
                session._id,
            },
            {
              $set: {
                revokedAt:
                  now(),

                revokeReason:
                  'ROTATED',
              },
            },
          );

        const tokens =
          await issueTokens({
            db,
            user,
            req,
          });

        return res.json({
          user:
            publicUser(
              user,
            ),

          ...tokens,
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // ME
  // ============================================

  router.get(
    '/me',
    authenticate,
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const user =
          req.auth.user;

        let driver = null;

        if (
          Array.isArray(
            user.roles,
          ) &&
          user.roles.includes(
            'DRIVER',
          )
        ) {
          driver =
            await db
              .collection('drivers')
              .findOne({
                userId:
                  user._id,
              });
        }

        return res.json({
          user:
            publicUser(
              user,
            ),

          driver:
            driver
              ? {
                  id:
                    String(
                      driver._id,
                    ),

                  approvalStatus:
                    driver.approvalStatus,

                  onlineStatus:
                    driver.onlineStatus,

                  rating:
                    Number(
                      driver.rating ||
                      0,
                    ),
                }
              : null,
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // LOGOUT
  // ============================================

  router.post(
    '/logout',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const refreshToken =
          String(
            req.body
              ?.refreshToken ||
            '',
          );

        if (
          refreshToken
        ) {
          await db
            .collection(
              'auth_sessions',
            )
            .updateOne(
              {
                tokenHash:
                  sha256(
                    refreshToken,
                  ),

                revokedAt:
                  null,
              },
              {
                $set: {
                  revokedAt:
                    now(),

                  revokeReason:
                    'LOGOUT',
                },
              },
            );
        }

        return res.json({
          ok: true,

          message:
            'Đã đăng xuất.',
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  return router;
}

module.exports = {
  createAuthRouter,
  createAuthenticate,
  publicUser,
};

