# TH79 iMove Core Backend 1.6.0

Node.js/Express Core API cho TH79 iMove. Development port `5050`, MongoDB database mặc định `th79_imove`.

## Development

```bash
cp .env.example .env
npm install
npm run check
npm test
npm run dev
```

## VPS production

Bản này được chuẩn hóa để chạy sau Nginx/PM2:

- Node production mặc định bind `127.0.0.1:5050`.
- Public Core URL: `https://backendimove.daututh79.com`.
- Không LAN discovery / UDP / Atlas service registry trong production.
- `/live` = process liveness.
- `/health` = API + MongoDB health cho Admin Gateway.
- `/ready` = readiness đầy đủ theo các dependency được đánh dấu required.
- Redis và FCM có thể để optional trong giai đoạn hiện tại.
- Auto database repair có thể tắt khi restart production; chạy migration thủ công.
- PM2 graceful shutdown và timeout phù hợp reverse proxy.

Xem `deploy/DEPLOY_VPS.md` và `deploy/.env.vps.example`.
