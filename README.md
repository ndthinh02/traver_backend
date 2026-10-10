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

Điền `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTP_PEPPER` riêng/ngẫu nhiên ít nhất 32 ký tự; thay mọi placeholder. Giữ `.env` ngoài git. Các TTL token nằm trong `.env.example`.

`MAIL_MODE=console` chỉ dev, OTP 4 số ngẫu nhiên trên terminal, không trả trong API. SMTP cần `SMTP_HOST/PORT/USER/PASS/FROM`. Production yêu cầu SMTP và `PUBLIC_BASE_URL` HTTPS. OTP TTL 5 phút, 5 lần thử, khóa 15 phút, resend 30 giây và rate limit IP/email/purpose; password bcrypt, refresh rotation/reuse detection, session/version revocation.

Booking env mới:

```dotenv
BOOKING_HOLD_MINUTES=15
BOOKING_CLEANUP_SECONDS=30
ENABLE_PAYMENT_SIMULATION=false
```

Để thử payment: `NODE_ENV=development`, bật `ENABLE_PAYMENT_SIMULATION=true` explicit, restart. Local `.env` đã bật; production không đăng ký endpoint simulation dù bật cờ. Không có payment provider/webhook thật.

Server bind `0.0.0.0:8080`, kết nối và kiểm tra Mongo replica set trước listen. Health `/api/health` trả 503 khi DB không sẵn sàng. Emulator: `http://10.0.2.2:8080/`; điện thoại thật: `http://192.168.2.197:8080/` hiện tại, cùng Wi-Fi/Firewall Private TCP8080. `PUBLIC_BASE_URL` phải truy cập được từ client để tải avatar.

Server đang chạy ở PC vẫn là code cũ (route quote 404); dừng trong terminal cũ và start lại để nạp model/route/worker mới. Không tự seed mỗi startup. `seed` có 36 tour tham khảo và departure 30 ngày tới. Mặc định chỉ thêm tour mới và ngày mới; `npm.cmd run seed -- --refresh-catalog --photos` cập nhật nội dung catalog tham khảo đã seed, nhập ảnh Wikimedia có giấy phép và ghi nguồn ở `/uploads/catalog/credits.html`. Không sửa giá/đơn/counters hiện có. Cần mạng để tải ảnh; cache và credits nằm trong uploads/catalog. Không tự cập nhật sản phẩm do nhà cung cấp chỉnh ngoài catalog seed.

## Booking API

Tiền tố `/api`, protected bằng Bearer access token. Envelope `{code,message,data}`; lỗi `{code,message,fieldErrors?,data?}`. Owner lấy từ auth, client không ghi owner/status/paid/total.

| Route | Payload/kết quả chính |
|---|---|
| GET `/tours/:id/departures?page=1&limit=50` | Lịch open/chưa khởi hành; id, date, timezone, capacity, remaining. Sold-out có remaining=0, không chọn được trên Android |
| POST `/bookings/quote` | `{departureId,adults,children}` → price breakdown, quoteToken, policy, remaining, serverTime; chưa giữ chỗ |
| POST `/bookings` | `{departureId,adults,children,contact:{name,email,phone},method:"Card" hoặc "Transfer",quoteToken,idempotencyKey:UUID}` → pending booking/holdExpiresAt/serverTime |
| GET `/users/me/bookings` | page/limit=10, filter=upcoming/completed/cancelled/expired/all, q; items/total/hasMore, sort createdAt + ID |
| GET `/bookings/:id` | Owner detail, snapshot, breakdown, status/paymentStatus, events, canCancel |
| POST `/bookings/:id/cancel` | `{reason?}`; idempotent, policy server và trả ghế một lần |
| POST `/bookings/:id/payment-simulation` | `{result:"success" hoặc "failure" hoặc "cancel"}`; chỉ development/test + flag, đơn simulation |
| GET `/bookings/:id/ticket` | Chỉ confirmed/completed; booking và QR thử không chứa contact/token |
| GET `/users/me/notifications` | page/limit, items/total/hasMore/unreadCount |
| PATCH `/users/me/notifications/:id/read` | Owner, body rỗng |
| POST `/users/me/notifications/read-all` | Owner, body rỗng |

Ngày `YYYY-MM-DD` theo timezone tour; lịch/end date dùng calendar, không chia/chồng millis qua DST. Event timestamp ISO UTC. Tiền nguyên cents USD; max 20 người, adults>=1, children>=0. Server tính price adult/child subtotals + fee; quote HMAC/JWT gắn user/departure/participants và phiên bản giá/chính sách. `PRICE_CHANGED` trả breakdown mới; Android tải quote mới để xác nhận lại.

Unique `(userId,idempotencyKey)`: cùng payload trả cùng đơn, khác payload trả `IDEMPOTENCY_CONFLICT`; không kéo dài hold khi retry. Hold hết hạn sau cấu hình hoặc lúc khởi hành nếu sớm hơn. Tăng held, chuyển held→booked, cancel/expire giảm counters và tạo event/notification cùng transaction; atomic capacity condition, retry transient tối đa 5 lượt. Worker không overlap, xử lý từng batch; reconcile expiry khi đọc departure/đơn và tạo hold, không dùng TTL xóa đơn.

`PENDING_PAYMENT → CONFIRMED/EXPIRED/CANCELLED`; `CONFIRMED → CANCELLED` trước deadline calendar hoặc `COMPLETED` sau endsAt bởi worker. Payment riêng `UNPAID/FAILED/SIMULATED_PAID/CANCELLED`. Failure/cancel payment attempt giữ nguyên hold đến hạn; không phải hủy booking. Hủy đơn confirmed áp dụng snapshot cancelDays, simulation không chuyển tiền/hoàn tiền thật.

Error codes: `SOLD_OUT`, `DEPARTURE_CLOSED`, `INVALID_PARTICIPANTS`, `PRICE_CHANGED`, `QUOTE_EXPIRED`, `HOLD_EXPIRED`, `INVALID_BOOKING_STATE`, `CANCELLATION_NOT_ALLOWED`, `IDEMPOTENCY_CONFLICT`, `BOOKING_NOT_FOUND`, `PAYMENT_UNAVAILABLE`; Android dịch Việt/Anh.

## Auth/catalog hiện có

| Route | Request chính |
|---|---|
| POST `/auth/register/start` | name/email/password → challenge |
| POST `/auth/register/verify` | challengeId/otp → tokens/user |
| POST `/auth/otp/resend` | challengeId/purpose register hoặc reset |
| POST `/auth/login`, `/auth/refresh`, `/auth/logout` | email/password; refreshToken; protected logout |
| POST `/auth/password/forgot`, `/verify`, `/reset`, `/change` | Trong prefix `/auth/password`: email; challengeId/otp → resetToken; challengeId/resetToken/newPassword/confirmPassword; currentPassword/newPassword/confirmPassword |
| GET/PATCH `/users/me`, POST `/users/me/avatar` | name/phone/interests; multipart avatar JPG/PNG/WebP <=3 MB, kiểm tra bytes |
| GET `/categories`, `/tours`, `/tours/:id`, `/tours/:id/related` | q/category/minPrice/maxPrice/minRating/services/page/limit/sort/featured/popular |
| GET `/users/me/favorites`, PUT/DELETE `/users/me/favorites/:tourId` | Phân trang, idempotent theo owner |
| GET `/tours/:id/reviews`, `/review-eligibility`, POST `/reviews` | Hai route cuối cùng dưới `/tours/:id`; protected eligibility/post, stars 1–5/text 10–2000 |

Sort tour name/price/priceDesc/rating, limit<=50, services comma yêu cầu đủ; sao aggregate Mongo. Catalog seed còn mẫu, ảnh local fallback/tọa độ mẫu, không phải nhà cung cấp được xác thực. Avatar lưu `uploads/`; deployment sau này cần persistent disk/object storage.

Review eligibility phải có booking COMPLETED đúng user/tour/provenance. Production chỉ source provider và review source user; simulation/development-fixture và review simulation bị loại. Startup đánh dấu lại review phase-1 từ fixture để không nhiễm rating production. Mỗi user/tour một review. Vé thử không có giá trị sử dụng; QR unsigned chỉ là tham chiếu, phải kiểm tra trạng thái server; chưa scanner/check-in/push.

## Management development

```powershell
npm.cmd run manage -- departure tour-0 2026-10-25 12 open
npm.cmd run manage -- departure tour-0 2026-10-25 12 closed
npm.cmd run manage -- complete BOOKING_OBJECT_ID
npm.cmd run seed:eligible -- user@example.com tour-1
```

Các script chỉ development. Departure validate date/capacity 0…10000, không giảm dưới held+booked; không reset đơn live. `complete` chỉ booking simulation cụ thể đang confirmed: thêm audit override thời điểm kết thúc rồi dùng chuyển trạng thái worker. Fixture eligibility explicit theo email, không tự cấp cho mọi user. Không có public endpoint đổi trạng thái/capacity hoặc tự completed.

Migration Mongo: thêm fields/indexes, khởi tạo timezone/start/end/counters cho departure cũ, bỏ **chỉ** unique index `(userId,tourId)` phase-1 để cho phép nhiều lần đặt; giữ dữ liệu và unique fixture riêng. Room v3 có bảng cache user mới, chuyển booking/notification local cũ sang legacy-demo; không upload/merge demo.

## Kiểm chứng thực tế

- `npm.cmd run check`: đạt kiểm tra cú pháp JS.
- HTTP app ở production, flag simulation=true: payment-simulation route **404**. Date-only/DST New York 08/03/2026: đạt, ngày kế tiếp cách 23h.
- `smoke:booking` có kiểm tra ghế cuối concurrent, idempotency/payload conflict, counters cancel/expiry lặp, retry payment không đổi hạn, ownership A/B, price change, worker restart, completion/provenance, paging/ticket/notification persist và production guard. Dùng database riêng tên kết thúc `_smoke`, development/console và flag=true; dọn chỉ fixture riêng, không drop DB.
- Đã thử chạy trên DB riêng Atlas: SRV DNS ETIMEOUT; dùng địa chỉ Windows resolve vẫn MongooseServerSelectionError. Chưa kết nối nên **chưa đạt smoke transaction**, chưa xác minh SMTP hoặc luồng Android đầu cuối. Log [.tmp/booking-smoke.log](../.tmp/booking-smoke.log), [lượt kết nối trực tiếp](../.tmp/booking-smoke-direct.log).
- Khi Mongo truy cập được, đặt URI database riêng `_smoke` và chạy `npm.cmd run smoke:booking`; `npm.cmd run smoke` là smoke auth phase-1. Không dùng URI database app để smoke.
- Dependencies hiện import được; lockfile vẫn thiếu metadata tarball/integrity ở express-rate-limit 8.1.0, helmet 8.1.0, ip-address 10.0.1, nodemailer 7.0.10, zod 4.1.12. Cần online `npm install --package-lock-only` rồi `npm ci` để hoàn thiện/kiểm chứng cài sạch.
- Android build/test/APK: xem [README gốc](../README.md). Chưa hosting, admin web, push hay tích hợp thu tiền thật; không coi là production-ready.
## Sửa lỗi CastError khi tạo/xác nhận thanh toán

`events` trước đây bị Mongoose hiểu là `Array<String>` do field tên `type` trong schema inline. Đã đổi sang `bookingEventSchema` riêng để lưu event object (id/type/at/actor/note). `npm.cmd run check` và `node scripts/check-booking-model.js` đã đạt: thêm event cho các trạng thái, serialize/hydrate, kiểm tra ngày sai; không dùng DB. Chưa kiểm chứng lại giao dịch thanh toán trên Atlas. Khởi động lại backend để nạp schema mới; không thay Android/APK hoặc xóa dữ liệu. Nếu hold đã hết hạn, chọn ngày và tạo đơn mới theo server.
Tạo lịch cho tour đã nhập trực tiếp MongoDB (development): `npm.cmd run seed:departures` hoặc `npm.cmd run seed:departures -- --tour=tour-24 --days=30`. Chỉ thêm ngày mới, không thay catalog/ảnh/giá/lịch đóng hoặc counters. remaining tính từ capacity-heldSeats-bookedSeats trong departures.


## OTP gửi email thật — 10/10/2026

MAIL_MODE trong backend/.env và .env.example đã chuyển sang smtp. Không tự chuyển về in mã ra terminal khi SMTP lỗi. Điền thông tin tài khoản gửi email trong backend/.env; không gửi mật khẩu vào chat hoặc commit file này. Cấu hình ví dụ Gmail:

```dotenv
MAIL_MODE=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM="Traver <your-email@gmail.com>"
```

Gmail cần bật xác minh hai bước và tạo App Password; dùng mật khẩu ứng dụng thay cho mật khẩu đăng nhập thường: [hướng dẫn Google](https://support.google.com/accounts/answer/185833?hl=vi). Nếu dùng dịch vụ SMTP khác, điền host/port/credentials và địa chỉ gửi đã được dịch vụ cho phép. Cổng 465 dùng TLS trực tiếp, các cổng khác yêu cầu STARTTLS. Thiết lập theo [Nodemailer SMTP](https://nodemailer.com/smtp).

```powershell
cd backend
npm.cmd run mail:check
# Sau khi kiểm tra đạt, dừng backend cũ trong terminal rồi chạy:
npm.cmd start
```

mail:check chỉ kiểm tra kết nối/TLS/đăng nhập, không gửi email hay log thông tin nhạy cảm. Đăng ký tài khoản mới hoặc quên mật khẩu từ app để kiểm tra hộp thư thật; xem cả thư rác. Quên mật khẩu vẫn trả lời chung cho email không tồn tại; mã không được gửi nếu tài khoản không tồn tại.

Email có nội dung text/HTML tiếng Việt, tiêu đề riêng đăng ký/đặt lại mật khẩu, OTP 4 số và thời hạn 5 phút. Giữ giới hạn 5 lần nhập sai và cooldown gửi lại 30 giây. SMTP có thời hạn tổng 15 giây, kiểm tra người nhận được chấp nhận; lỗi chỉ log mã nguyên nhân an toàn, không log OTP/email/password trong chế độ smtp. Gửi thất bại sẽ xóa digest, hết hạn mã và bỏ cooldown của challenge đó để có thể yêu cầu lại (rate limit chống spam vẫn giữ). App báo không gửi được email và hướng dẫn kiểm tra thư rác; màn quên mật khẩu không khẳng định tài khoản tồn tại.

Đã chạy npm.cmd run check: đạt. npm.cmd run test:mail: 6/6 đạt (nội dung MIME text/HTML, TLS, người nhận bị từ chối, thiếu cấu hình/lỗi xác thực, timeout và App Password có khoảng trắng). Đây là kiểm tra offline/mock, không chứng minh email đã đến hộp thư. npm.cmd run mail:check thực tế thất bại với SMTP_NOT_CONFIGURED: hiện SMTP_HOST/USER/PASS/FROM chưa được điền. Chưa gửi email thật hoặc kiểm chứng đăng ký/OTP end-to-end trên MongoDB. Backend đang chạy cần restart để nạp cấu hình/code mới.
