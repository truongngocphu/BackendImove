# TH79 iMove Backend - deploy/fix Core Backend

## Lỗi đã phát hiện trong bản gốc

1. `.env` gốc có nhiều biến bị khai báo lặp, trong đó có `NODE_ENV`. Bản gốc có cả `NODE_ENV=production` và `NODE_ENV=development`, nên runtime có thể chạy sai môi trường.
2. `/api/health` và các health endpoint cũ trả schema không đồng nhất (`success` ở chỗ này, `ok` ở chỗ khác).
3. `/api/v73/admin/health` nằm sau middleware Admin auth, nên trang đăng nhập chưa có token có thể nhận 401 và hiển thị "Không tìm thấy Core Backend".
4. `production_service.systemHealth()` coi FCM chưa cấu hình là `ok=false`, dù FCM được thiết kế là optional.
5. Production guard trước đây ép Redis phải có dù `REDIS_REQUIRED=false` có thể là cấu hình hợp lệ.
6. HTTP log chưa hiển thị response JSON nên khó biết nguyên nhân lỗi thực tế.

## Health endpoint public tương thích

Các URL sau đều không yêu cầu token và trả cùng schema:

- `/health`
- `/api/health`
- `/api/core/health`
- `/api/admin/health`
- `/api/v73/health`
- `/api/v73/admin/health`
- `/ready`

Admin login có thể dùng `/health` hoặc `/api/health`.

## Admin login aliases

Backend hỗ trợ cả:

- `POST /api/admin-auth/login`
- `POST /api/v73/admin-auth/login`
- `POST /api/v73/admin/login`

## Cài trên VPS

1. Backup backend cũ.
2. Giữ lại `.env` thật của VPS, nhưng chạy `npm run check:vps` và xóa các key bị trùng.
3. Copy source mới lên VPS.
4. `npm ci --omit=dev`
5. `npm run check`
6. `npm run check:vps`
7. `pm2 restart imove --update-env`
8. `pm2 logs imove --lines 300`

## Kiểm tra nhanh

```bash
curl -i https://backendimove.daututh79.com/health
curl -i https://backendimove.daututh79.com/api/health
curl -i https://backendimove.daututh79.com/api/v73/admin/health
```

Khi MongoDB/Core hoạt động, các endpoint phải trả HTTP 200 và có:

```json
{"ok":true,"ready":true,"backend":true,"coreBackend":true,"database":true}
```

FCM hoặc Redis optional chưa cấu hình chỉ xuất hiện trong `warnings`, không được làm Core Backend offline.

## F12 / PM2 diagnostics

Mỗi response có header `X-Request-Id`. Khi API lỗi, PM2 log sẽ in:

- method + URL
- HTTP status
- requestId
- Origin/Referer
- query/params/body (secret được che)
- response JSON thực tế
- user/admin id nếu có

Vì vậy khi F12 thấy lỗi, lấy `X-Request-Id` và tìm đúng request trong `pm2 logs`.
