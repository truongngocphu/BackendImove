# TH79 iMove Core Backend 1.6.0 — VPS

## Kiến trúc production

Internet → `https://backendimove.daututh79.com` → Nginx :443 → Node `127.0.0.1:5050` → MongoDB Atlas.

Node không mở trực tiếp port 5050 ra Internet. LAN discovery và MongoDB service registry bị tắt trên VPS; Core có một public URL duy nhất là `https://backendimove.daututh79.com`.

## 1. Chuẩn bị source

```bash
cd /var/www/th79-imove-backend
cp deploy/.env.vps.example .env
nano .env
```

Điền tối thiểu `MONGODB_URI`, `JWT_ACCESS_SECRET`, `KYC_DATA_KEY`, `FACE_EVIDENCE_KEY`. Không commit `.env`.

## 2. Cài dependency và kiểm tra

Yêu cầu Node.js 20–24.

```bash
npm ci --omit=dev
npm run check
npm run check:vps
mkdir -p logs storage/kyc
```

Nếu database đã được dùng ở bản cũ, chạy migration một lần trước khi bật PM2:

```bash
npm run db:migrate
```

## 3. Chạy PM2

```bash
pm2 delete th79-imove-core 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
pm2 logs th79-imove-core --lines 100
```

Kiểm tra nội bộ:

```bash
curl -i http://127.0.0.1:5050/live
curl -i http://127.0.0.1:5050/health
curl -i http://127.0.0.1:5050/ready
```

`/live` phải luôn trả 200 khi process sống. `/health` trả 200 khi MongoDB sẵn sàng. `/ready` chỉ trả 200 khi các dependency được đánh dấu `required` đều sẵn sàng.

## 4. Nginx + SSL

Lần đầu chưa có certificate, dùng `deploy/nginx-backendimove-http-first.conf.example`, enable site rồi chạy:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d backendimove.daututh79.com
```

Sau khi certificate tồn tại, dùng `deploy/nginx-backendimove.conf.example`, rồi:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Kiểm tra public:

```bash
curl -i https://backendimove.daututh79.com/live
curl -i https://backendimove.daututh79.com/health
```

## 5. Các giá trị production quan trọng

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=5050
CORE_PUBLIC_URL=https://backendimove.daututh79.com
CORS_ORIGINS=https://imove.daututh79.com
LAN_DISCOVERY_ENABLED=false
SERVICE_REGISTRY_ENABLED=false
DB_REPAIR_ON_START=false
REDIS_REQUIRED=false
FCM_REQUIRED=false
FACE_PROVIDER_MODE=MANUAL
```

Nếu sau này Redis/FCM đã cấu hình thật, đổi `*_REQUIRED=true` tương ứng.

## 6. Admin Vercel - không còn Gateway 5060

Bản này đã gộp các API quản trị cần thiết vào Core Backend. Không cần chạy Admin Gateway port 5060, không cần thêm Nginx `/admin-gateway`, và không cần rewrite API trên Vercel.

Admin frontend gọi trực tiếp:

```text
https://backendimove.daututh79.com
```

Kiểm tra sau deploy:

```bash
curl -i https://backendimove.daututh79.com/api/health
```

Kết quả đúng có `service: TH79_IMOVE_CORE_ADMIN` và `mergedIntoCore: true`.

Các route quản trị đã gộp gồm `/api/bootstrap`, `/api/data/*`, `/api/admin-access/*`, `/api/admin-management/*`, `/api/admin-profile`, `/api/admin-audit` và các route pricing legacy mà Admin hiện tại đang dùng. Các route dữ liệu nhạy cảm yêu cầu Bearer token ADMIN.
