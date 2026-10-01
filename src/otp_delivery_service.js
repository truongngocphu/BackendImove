const crypto = require('crypto');

function clean(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').trim();
}

function normalizeSpeedSmsPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return '';
  // SpeedSMS supports international numbers. For VN we normalize 09xx -> 849xx.
  if (phone.startsWith('84')) return phone;
  if (phone.startsWith('0')) return `84${phone.slice(1)}`;
  return phone;
}

function maskPhone(phone) {
  const p = normalizePhone(phone);
  if (p.length < 6) return p;
  return `${p.slice(0, 3)}***${p.slice(-3)}`;
}

async function readProviderResponse(response) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  return { text, json };
}

async function postJson(url, payload, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const { text } = await readProviderResponse(response);
    if (!response.ok) {
      const err = new Error(`SMS provider trả HTTP ${response.status}.`);
      err.providerBody = text.slice(0, 400);
      throw err;
    }
    return { ok: true, providerBody: text.slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaSpeedSms({ phone, message }) {
  const accessToken = clean(process.env.SPEEDSMS_ACCESS_TOKEN, 1000);
  if (!accessToken) throw new Error('SPEEDSMS_ACCESS_TOKEN chưa được cấu hình.');

  const url = clean(
    process.env.SPEEDSMS_API_URL || 'https://api.speedsms.vn/index.php/sms/send',
    500,
  );
  const smsType = Number(process.env.SPEEDSMS_SMS_TYPE || 2);
  const sender = clean(process.env.SPEEDSMS_SENDER || '', 80);
  const timeoutMs = Math.max(2000, Number(process.env.SMS_TIMEOUT_MS || 8000));

  if (![2, 3, 4, 5].includes(smsType)) {
    throw new Error('SPEEDSMS_SMS_TYPE phải là 2, 3, 4 hoặc 5.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // SpeedSMS official API uses HTTP Basic Authentication:
    // username = access token, password = x.
    const basic = Buffer.from(`${accessToken}:x`, 'utf8').toString('base64');
    const payload = {
      to: [normalizeSpeedSmsPhone(phone)],
      content: message,
      sms_type: smsType,
      sender,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const { text, json } = await readProviderResponse(response);
    if (!response.ok) {
      const error = new Error(`SpeedSMS trả HTTP ${response.status}.`);
      error.providerBody = text.slice(0, 400);
      throw error;
    }
    if (!json || json.status !== 'success' || String(json.code) !== '00') {
      const code = json?.code ?? 'UNKNOWN';
      const messageText = json?.message || 'SpeedSMS gửi SMS thất bại.';
      const error = new Error(`SpeedSMS lỗi ${code}: ${messageText}`);
      error.providerBody = text.slice(0, 400);
      throw error;
    }

    return {
      delivered: true,
      provider: 'SPEEDSMS',
      transactionId: json?.data?.tranId ?? null,
      totalSMS: json?.data?.totalSMS ?? null,
      totalPrice: json?.data?.totalPrice ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendOtpSms({ phone, otp, purpose = 'PHONE_VERIFY' }) {
  const provider = clean(process.env.SMS_PROVIDER || 'NONE', 40).toUpperCase();
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const minutes = Math.max(1, Number(process.env.AUTH_OTP_MINUTES || 5));
  const sender = clean(process.env.SMS_SENDER || 'TH79 IMOVE', 40);
  const messageTemplate = clean(
    process.env.SMS_OTP_TEMPLATE ||
      'TH79 iMove: Ma OTP cua ban la {OTP}. Ma co hieu luc {MINUTES} phut. Khong chia se ma nay.',
    500,
  );
  const message = messageTemplate
    .replaceAll('{OTP}', String(otp))
    .replaceAll('{MINUTES}', String(minutes))
    .replaceAll('{PURPOSE}', String(purpose));

  if (provider === 'SPEEDSMS') {
    return sendViaSpeedSms({ phone, message, purpose });
  }

  if (provider === 'HTTP') {
    const url = clean(process.env.SMS_HTTP_URL, 500);
    if (!url) throw new Error('SMS_HTTP_URL chưa được cấu hình.');
    const token = clean(process.env.SMS_HTTP_TOKEN, 1000);
    const timeoutMs = Math.max(2000, Number(process.env.SMS_TIMEOUT_MS || 8000));
    await postJson(
      url,
      {
        phone: normalizePhone(phone),
        message,
        sender,
        purpose,
        requestId: crypto.randomUUID(),
      },
      token,
      timeoutMs,
    );
    return { delivered: true, provider: 'HTTP' };
  }

  if (provider === 'CONSOLE' && !production) {
    console.info(`[OTP DEV] ${maskPhone(phone)} ${purpose}: ${otp}`);
    return { delivered: true, provider: 'CONSOLE' };
  }

  if (!production && String(process.env.AUTH_DEV_SHOW_OTP || 'false').toLowerCase() === 'true') {
    console.info(`[OTP DEV] ${maskPhone(phone)} ${purpose}: ${otp}`);
    return { delivered: false, provider: 'DEV_SHOW_OTP' };
  }

  throw new Error(
    'Chưa cấu hình nhà cung cấp SMS OTP. Với SpeedSMS đặt SMS_PROVIDER=SPEEDSMS và SPEEDSMS_ACCESS_TOKEN.',
  );
}

async function assertOtpThrottle(db, { phone, purpose }) {
  const normalized = normalizePhone(phone);
  const windowSeconds = Math.max(30, Number(process.env.AUTH_OTP_RESEND_SECONDS || 60));
  const maxPerHour = Math.max(2, Number(process.env.AUTH_OTP_MAX_PER_HOUR || 6));
  const now = new Date();
  const recent = await db.collection('otp_verifications').findOne(
    {
      phone: normalized,
      purpose,
      createdAt: { $gte: new Date(Date.now() - windowSeconds * 1000) },
    },
    { sort: { createdAt: -1 } },
  );
  if (recent) {
    const retryAfter = Math.max(
      1,
      Math.ceil((recent.createdAt.getTime() + windowSeconds * 1000 - now.getTime()) / 1000),
    );
    const error = new Error(`Vui lòng chờ ${retryAfter} giây trước khi yêu cầu OTP mới.`);
    error.httpStatus = 429;
    error.retryAfter = retryAfter;
    throw error;
  }

  const count = await db.collection('otp_verifications').countDocuments({
    phone: normalized,
    purpose,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  });
  if (count >= maxPerHour) {
    const error = new Error('Bạn đã yêu cầu quá nhiều OTP. Vui lòng thử lại sau.');
    error.httpStatus = 429;
    throw error;
  }
}

module.exports = {
  sendOtpSms,
  sendViaSpeedSms,
  assertOtpThrottle,
  normalizePhone,
  normalizeSpeedSmsPhone,
};
