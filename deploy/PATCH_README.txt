TH79 iMove Backend 1.6.0 - VPS READY PATCH

1. Sao lưu Backend hiện tại.
2. Giải nén PATCH và chép đè các file vào thư mục Backend hiện tại.
3. KHÔNG xóa .env hiện có. Mở deploy/UPDATE_EXISTING_ENV_VPS.txt và sửa các dòng tương ứng.
4. Trên VPS chạy:
   npm ci --omit=dev
   npm run check
   npm run check:vps
   npm run db:migrate        # chạy 1 lần khi nâng cấp schema
   mkdir -p logs storage/kyc
   pm2 restart th79-imove-core --update-env
5. Kiểm tra:
   curl -i http://127.0.0.1:5050/live
   curl -i http://127.0.0.1:5050/health
   curl -i https://backendimove.daututh79.com/health

Xem deploy/DEPLOY_VPS.md để cấu hình Nginx/SSL.
