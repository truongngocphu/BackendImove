# TH79 iMove Backend 1.6.0 - Core + Admin Console API

## Mục tiêu

Giữ nguyên VPS/Nginx hiện tại: `backendimove.daututh79.com -> 127.0.0.1:5050`.
Không mở port mới và không cần sửa Nginx.

Admin Gateway 5060 đã được loại khỏi kiến trúc production. Các API Admin cần thiết được mount trực tiếp vào Core Backend.

## Sau khi deploy

```bash
curl -i http://127.0.0.1:5050/health
curl -i http://127.0.0.1:5050/api/health
curl -i https://backendimove.daututh79.com/api/health
```

`/health` là health của Core. `/api/health` là health của lớp Admin Console đã gộp.

## Route Admin trực tiếp

- `GET /api/admin-access/me`
- `GET /api/bootstrap`
- `GET /api/data/:key`
- `PUT /api/data/:key`
- `GET/PATCH /api/admin-profile`
- `POST /api/admin-profile/password`
- `/api/admin-management/*`
- `GET /api/admin-audit`
- `/api/pricing/*` legacy dùng bởi Admin hiện tại

Đăng nhập vẫn dùng `POST /api/admin-auth/login` của Core.

## Không thay đổi

- Domain Backend
- Port 5050
- Nginx site hiện tại
- MongoDB database
- User/Driver/Merchant API hiện có

## CORS

Production `.env` cần có:

```env
CORS_ORIGINS=https://imove.daututh79.com
```

Native apps không gửi Origin nên vẫn hoạt động bình thường.
