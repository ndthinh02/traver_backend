import crypto from 'node:crypto';
import { config } from '../config.js';
import { Challenge, AuthThrottle } from '../models/index.js';
import { fail } from '../middleware/http.js';
import { sendOtp } from './mail.js';
export const digest = (id, purpose, otp) => crypto.createHmac('sha256', config.OTP_PEPPER).update(`${id}:${purpose}:${otp}`).digest('hex');
export const challengeView = c => ({ challengeId: String(c._id), purpose: c.purpose, expiresAt: c.expiresAt, resendAfterSeconds: Math.max(0, Math.ceil((c.resendAt - Date.now()) / 1000)), mailMode: config.MAIL_MODE });
export async function emailLimit(email, purpose, max = 5) {
  const window = Math.floor(Date.now() / 900000);
  const key = crypto.createHmac('sha256', config.OTP_PEPPER).update(email + ':' + purpose + ':' + window).digest('hex');
  const state = await AuthThrottle.findOneAndUpdate({ _id: key }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 2) * 900000) } }, { upsert: true, new: true });
  if (state.count > max) fail(429, 'RATE_LIMITED');
}
export async function startChallenge(email, purpose, fields = {}) {
  const now = new Date();
  let c = await Challenge.findOne({ email, purpose });
  if (c?.lockUntil > now) fail(429, 'RATE_LIMITED');
  if (c && c.resendAt > now) fail(429, 'OTP_COOLDOWN');
  await emailLimit(email, purpose);
  if (!c) c = new Challenge({ email, purpose });
  const otp = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  // Mail failure leaves no usable challenge. A conditional write enforces cooldown across workers.
  const values = { ...fields, lockUntil: null, digest: digest(c._id, purpose, otp), attempts: 0, expiresAt: new Date(Date.now() + 300000), resendAt: new Date(Date.now() + 30000), cleanupAt: new Date(Date.now() + 86400000), consumedAt: null, resetHash: null, resetExpiresAt: null, resetUsedAt: null };
  if (c.isNew) { Object.assign(c, values); await c.save(); }
  else { c = await Challenge.findOneAndUpdate({ _id: c._id, resendAt: { $lte: now } }, { $set: values }, { new: true }); if (!c) fail(429, 'OTP_COOLDOWN'); }
  try { await sendOtp(email, purpose, otp); }
  catch (e) { await Challenge.updateOne({ _id: c._id, digest: values.digest }, { $set: { consumedAt: new Date(), digest: null, expiresAt: new Date(0), resendAt: new Date(0) } }); throw e; }
  return challengeView(c);
}
export async function checkedChallenge(id, purpose, otp) {
  const c = await Challenge.findOneAndUpdate({ _id: id, purpose, consumedAt: null, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } }, { new: true }).select('+digest +passwordHash');
  if (!c) fail(400, 'OTP_EXPIRED');
  const expected = Buffer.from(digest(id, purpose, otp), 'hex');
  if (!c.digest || !crypto.timingSafeEqual(expected, Buffer.from(c.digest, 'hex'))) {
    if (c.attempts >= 5) await Challenge.updateOne({ _id: c._id, digest: c.digest }, { $set: { lockUntil: new Date(Date.now() + 900000) } });
    fail(400, 'OTP_INVALID');
  }
  return c;
}
