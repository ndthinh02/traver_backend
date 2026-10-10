import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { app } from '../src/app.js';
import { User, Tour, Review, Favorite, Booking, Session, Challenge, Departure, AuthThrottle } from '../src/models/index.js';
if (config.NODE_ENV === 'production' || config.MAIL_MODE !== 'console') throw new Error('Smoke requires development/test and MAIL_MODE=console');
if (!config.MONGODB_URI.split('?')[0].split('/').at(-1).endsWith('_smoke')) throw new Error('Use a separate database ending in _smoke');
const prefix = `smoke-${Date.now()}`; const emailA = `${prefix}-a@example.test`; const emailB = `${prefix}-b@example.test`;
let server; let base; let deliveredOtp;
const originalInfo = console.info;
console.info = (...args) => { const match = String(args[0]).match(/^\[DEV MAIL (?:register|reset)\].*: (\d{4})$/); if (match) deliveredOtp = match[1]; else originalInfo(...args); };
async function call(path, body, token, method = body ? 'POST' : 'GET', status = 200) {
  const response = await fetch(`${base}/api/${path}`, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.equal(response.status, status, `${path}: ${data.code}`); return data.data || data;
}
async function register(email) { const c = await call('auth/register/start', { email, name: 'Smoke User', password: 'SmokePass123' }); const otp = deliveredOtp;
  assert(!('otp' in c)); await call('auth/register/verify', { challengeId: c.challengeId, otp: otp === '0000' ? '0001' : '0000' }, null, 'POST', 400);
  const session = await call('auth/register/verify', { challengeId: c.challengeId, otp }); await call('auth/register/verify', { challengeId: c.challengeId, otp }, null, 'POST', 400); return session;
}
try {
  await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await Promise.all([User,Tour,Review,Favorite,Booking,Session,Challenge,Departure,AuthThrottle].map(m => m.init()));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  await call('health');
  for (let i=0;i<24;i++) await Tour.create({ _id: `${prefix}-${i}`, slug: `${prefix}-${i}`, name: `${prefix} ${String(i).padStart(2,'0')}`, category: 'Beach', location: 'Sample', lat: 0, lon: 0, image: 'kuta', gallery: ['kuta'], description: 'Smoke', descriptionVi: 'Smoke', itinerary: ['Sample'], itineraryVi: ['Mẫu'], services: ['Meals','Guide'], days: 2, price: 20000+i, childPrice: 12000, fee: 1500, capacity: 10, currency: 'USD', cancelDays: 3 });
  const a = await register(emailA); const b = await register(emailB); const id = `${prefix}-0`;
  await call('auth/login', { email: emailA, password: 'wrong-password' }, null, 'POST', 401);
  await call('users/me', null, null, 'GET', 401); await call('users/me', null, 'invalid-token', 'GET', 401);
  const first = await call(`tours?q=${prefix}&category=Beach&services=Meals,Guide&minPrice=20000&maxPrice=20023&page=1&limit=10`);
  const second = await call(`tours?q=${prefix}&category=Beach&services=Meals,Guide&minPrice=20000&maxPrice=20023&page=2&limit=10`);
  assert.equal(first.total,24); assert.equal(first.items.length,10); assert.equal(second.items.length,10); assert(!first.items.some(t=>second.items.some(u=>u.id===t.id)));
  await call(`users/me/favorites/${id}`, {}, a.accessToken, 'PUT'); await call(`users/me/favorites/${id}`, {}, a.accessToken, 'PUT');
  assert.equal((await call('users/me/favorites', null, a.accessToken)).total,1); assert.equal((await call('users/me/favorites',null,b.accessToken)).total,0);
  await call(`tours/${id}/reviews`, {stars:5,text:'Smoke completed review'}, b.accessToken, 'POST', 403);
  await Booking.create({userId:a.user.id,tourId:id,status:'COMPLETED',source:'development-fixture'});
  assert.equal((await call(`tours/${id}/review-eligibility`,null,a.accessToken)).eligible,true);
  const rated = await call(`tours/${id}/reviews`,{stars:5,text:'Smoke completed review'},a.accessToken); assert.equal(rated.ratingAverage,5); assert.equal(rated.ratingCount,1);
  await call(`tours/${id}/reviews`,{stars:4,text:'Duplicate smoke review'},a.accessToken,'POST',409);
  const expired = await call('auth/password/forgot',{email:emailB}); await Challenge.updateOne({_id:expired.challengeId},{$set:{expiresAt:new Date(0)}});
  await call('auth/password/verify',{challengeId:expired.challengeId,otp:deliveredOtp},null,'POST',400);
  const rotated = await call('auth/refresh',{refreshToken:b.refreshToken}); await call('auth/refresh',{refreshToken:b.refreshToken},null,'POST',401); await call('users/me',null,rotated.accessToken,'GET',401);
  const c = await call('auth/password/forgot',{email:emailA}); const reset = await call('auth/password/verify',{challengeId:c.challengeId,otp:deliveredOtp});
  await call('auth/password/reset',{challengeId:c.challengeId,resetToken:reset.resetToken,newPassword:'ChangedPass123',confirmPassword:'ChangedPass123'});
  await call('users/me',null,a.accessToken,'GET',401); await call('auth/login',{email:emailA,password:'SmokePass123'},null,'POST',401);
  const changed = await call('auth/login',{email:emailA,password:'ChangedPass123'});
  await call('auth/logout',{},changed.accessToken); await call('users/me',null,changed.accessToken,'GET',401);
  const again = await call('auth/login',{email:emailA,password:'ChangedPass123'});
  await call('auth/password/change',{currentPassword:'ChangedPass123',newPassword:'FinalPass123',confirmPassword:'FinalPass123'},again.accessToken);
  await call('users/me',null,again.accessToken,'GET',401); await call('auth/login',{email:emailA,password:'ChangedPass123'},null,'POST',401); await call('auth/login',{email:emailA,password:'FinalPass123'});
  originalInfo('Smoke passed: two-user auth/isolation, OTP wrong/expiry/reuse, refresh reuse, search pages, reviews/ratings, reset/change/revocation, logout/relogin');
} finally {
  console.info = originalInfo;
  if (mongoose.connection.readyState === 1) { const users = await User.find({email:{$in:[emailA,emailB]}}).select('_id'); const ids=users.map(u=>u._id); await Promise.all([Session.deleteMany({userId:{$in:ids}}),Favorite.deleteMany({userId:{$in:ids}}),Review.deleteMany({userId:{$in:ids}}),Booking.deleteMany({userId:{$in:ids}}),Challenge.deleteMany({email:{$in:[emailA,emailB]}}),User.deleteMany({_id:{$in:ids}}),Tour.deleteMany({_id:{$regex:`^${prefix}-`}})]); }
  if(server) await new Promise(resolve=>server.close(resolve)); await mongoose.disconnect();
}