# Traver API

Node >=22, Express + Mongoose. Dùng MongoDB replica set/Atlas cho transaction; không drop DB. Tài khoản/catalog/booking/favorites/reviews/notifications đều server-owned.

## Cấu hình/chạy

```powershell
cd backend
Copy-Item .env.example .env # Chỉ khi chưa có .env, không ghi đè cấu hình đang dùng
npm.cmd install --package-lock-only
npm.cmd ci
npm.cmd run check
npm.cmd run seed
npm.cmd start
```


