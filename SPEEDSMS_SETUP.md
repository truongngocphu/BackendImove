# SpeedSMS OTP - TH79 iMove

Cấu hình chỉ đặt trong `Backend/.env` trên VPS. Không đưa token vào Admin/User/Driver/Merchant.

```env
NODE_ENV=production
CUSTOMER_REGISTER_REQUIRE_OTP=true
AUTH_OTP_MINUTES=5
AUTH_OTP_RESEND_SECONDS=60
AUTH_OTP_MAX_PER_HOUR=6
AUTH_DEV_SHOW_OTP=false

SMS_PROVIDER=SPEEDSMS
SPEEDSMS_ACCESS_TOKEN=PASTE_YOUR_SPEEDSMS_ACCESS_TOKEN_HERE
SPEEDSMS_API_URL=https://api.speedsms.vn/index.php/sms/send
SPEEDSMS_SMS_TYPE=2
SPEEDSMS_SENDER=
SMS_TIMEOUT_MS=8000
SMS_OTP_TEMPLATE=TH79 iMove: Ma OTP cua ban la {OTP}. Ma co hieu luc {MINUTES} phut. Khong chia se ma nay.
```

## Test local có trả OTP ra app

Chỉ dùng khi chạy local/test:

```env
NODE_ENV=development
SMS_PROVIDER=CONSOLE
AUTH_DEV_SHOW_OTP=true
```

Khi đó `/api/auth/otp/request` trả thêm `devOtp` và User/Driver có thể hiển thị mã thử nghiệm. Production không trả OTP trong JSON; OTP được gửi bằng SpeedSMS.

## Production

Đặt token SpeedSMS thật vào `SPEEDSMS_ACCESS_TOKEN` bằng biến môi trường/VPS secret rồi restart Backend (PM2/systemd/Docker tùy cách deploy). Không commit `.env` lên Git.
