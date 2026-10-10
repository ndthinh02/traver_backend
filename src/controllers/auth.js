import mongoose from 'mongoose';
import { config } from '../config.js';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User, Session, Challenge } from '../models/index.js';
import { ok, parse, fail, email, password, objectId } from '../middleware/http.js';
import { hash, issueSession, refresh } from '../services/session.js';
import { startChallenge, checkedChallenge, emailLimit, challengeView } from '../services/challenge.js';
const verifySchema = z.object({ challengeId: objectId, otp: z.string().regex(/^\d{4}$/) }).strict();
const passwordFields = { newPassword: password, confirmPassword: password };
const matched = s => s.refine(v => v.newPassword === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords must match' });
export async function registerStart(req, res) {
  const v = parse(z.object({ email, password, name: z.string().trim().min(1).max(100) }).strict(), req.body);
  if (await User.exists({ email: v.email })) fail(409, 'EMAIL_EXISTS');
  ok(res, await startChallenge(v.email, 'register', { name: v.name, passwordHash: await bcrypt.hash(v.password, 12) }));
}
export async function registerVerify(req, res) {
  const v = parse(verifySchema, req.body); const c = await checkedChallenge(v.challengeId, 'register', v.otp);
  let result;
  await mongoose.connection.transaction(async transaction => {
    const consumed = await Challenge.updateOne({ _id: c._id, digest: c.digest, consumedAt: null, expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date() } }, { session: transaction });
    if (!consumed.modifiedCount) fail(400, 'OTP_EXPIRED');
    const [user] = await User.create([{ email: c.email, passwordHash: c.passwordHash, name: c.name, emailVerifiedAt: new Date() }], { session: transaction });
    result = await issueSession(user, transaction);
  }); ok(res, result);
}
export async function resend(req, res) {
  const v = parse(z.object({ challengeId: objectId, purpose: z.enum(['register', 'reset']) }).strict(), req.body);
  const c = await Challenge.findOne({ _id: v.challengeId, purpose: v.purpose, consumedAt: null }).select('+passwordHash');
  if (!c || c.attempts >= 5) fail(400, 'OTP_EXPIRED');
  if (c.purpose === 'register' && await User.exists({ email: c.email })) fail(409, 'EMAIL_EXISTS');
  // A non-existent reset user receives a generic, inert challenge and no mail.
  if (c.purpose === 'reset' && !await User.exists({ email: c.email, status: 'active' })) { if (c.resendAt > new Date()) fail(429, 'OTP_COOLDOWN'); await emailLimit(c.email, 'reset'); c.resendAt = new Date(Date.now() + 30000); c.expiresAt = new Date(Date.now() + 300000); await c.save(); return ok(res, challengeView(c)); }
  ok(res, await startChallenge(c.email, c.purpose, c.purpose === 'register' ? { name: c.name, passwordHash: c.passwordHash } : {}));
}
export async function login(req, res) {
  const v = parse(z.object({ email, password }).strict(), req.body);
  await emailLimit(v.email, 'login', 10);
  const user = await User.findOne({ email: v.email }).select('+passwordHash +sessionVersion');
  const dummy = '$2b$12$8TJwvNUY1G5p7DpxIcSoZ.97r1CaLljjyWYJuIOpmou8w7yYkbSqq';
  const valid = await bcrypt.compare(v.password, user?.passwordHash || dummy);
  if (!user || !valid || user.status !== 'active') fail(401, 'INVALID_CREDENTIALS');
  if (!user.emailVerifiedAt) fail(403, 'EMAIL_UNVERIFIED');
  ok(res, await issueSession(user));
}
export async function refreshSession(req, res) { const v = parse(z.object({ refreshToken: z.string().min(1).max(4096) }).strict(), req.body); ok(res, await refresh(v.refreshToken)); }
export async function logout(req, res) { await Session.updateOne({ _id: req.sessionId, userId: req.user._id }, { $set: { revokedAt: new Date() } }); ok(res); }
export async function forgot(req, res) {
  const v = parse(z.object({ email }).strict(), req.body);
  const existing = await Challenge.findOne({ email: v.email, purpose: 'reset' });
  if (existing?.lockUntil > new Date()) fail(429, 'RATE_LIMITED');
  if (existing?.resendAt > new Date()) fail(429, 'OTP_COOLDOWN');
  let result;
  if (await User.exists({ email: v.email, status: 'active' })) result = await startChallenge(v.email, 'reset');
  else {
    await emailLimit(v.email, 'reset');
    const c = await Challenge.findOneAndUpdate({ email: v.email, purpose: 'reset' }, { $set: { digest: null, attempts: 0, expiresAt: new Date(Date.now() + 300000), resendAt: new Date(Date.now() + 30000), cleanupAt: new Date(Date.now() + 86400000), consumedAt: null, resetHash: null } }, { upsert: true, new: true });
    result = { challengeId: String(c._id), purpose: 'reset', expiresAt: c.expiresAt, resendAfterSeconds: 30, mailMode: config.MAIL_MODE };
  }
  ok(res, { ...result, message: 'If an account exists, a verification email has been sent.' });
}
export async function verifyReset(req, res) {
  const v = parse(verifySchema, req.body); const c = await checkedChallenge(v.challengeId, 'reset', v.otp);
  const token = crypto.randomBytes(32).toString('base64url');
  const updated = await Challenge.updateOne({ _id: c._id, digest: c.digest, consumedAt: null, expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date(), resetHash: hash(token), resetExpiresAt: new Date(Date.now() + 300000), resetUsedAt: null } });
  if (!updated.modifiedCount) fail(400, 'OTP_EXPIRED');
  ok(res, { resetToken: token });
}
export async function resetPassword(req, res) {
  const v = parse(matched(z.object({ challengeId: objectId, resetToken: z.string().min(32).max(100), ...passwordFields }).strict()), req.body);
  const passwordHash = await bcrypt.hash(v.newPassword, 12);
  await mongoose.connection.transaction(async transaction => {
    const c = await Challenge.findOneAndUpdate({ _id: v.challengeId, purpose: 'reset', resetHash: hash(v.resetToken), resetUsedAt: null, resetExpiresAt: { $gt: new Date() } }, { $set: { resetUsedAt: new Date() } }, { new: true, session: transaction });
    if (!c) fail(400, 'RESET_EXPIRED');
    const user = await User.findOneAndUpdate({ email: c.email, status: 'active' }, { $set: { passwordHash }, $inc: { sessionVersion: 1 } }, { new: true, session: transaction });
    if (!user) fail(400, 'RESET_EXPIRED');
    await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session: transaction });
  }); ok(res);
}
export async function changePassword(req, res) {
  const v = parse(matched(z.object({ currentPassword: password, ...passwordFields }).strict()), req.body);
  const user = await User.findById(req.user._id).select('+passwordHash +sessionVersion');
  if (!await bcrypt.compare(v.currentPassword, user.passwordHash)) fail(400, 'CURRENT_PASSWORD_INVALID');
  const passwordHash = await bcrypt.hash(v.newPassword, 12);
  await mongoose.connection.transaction(async transaction => {
    const updated = await User.updateOne({ _id: user._id, sessionVersion: user.sessionVersion }, { $set: { passwordHash }, $inc: { sessionVersion: 1 } }, { session: transaction });
    if (!updated.modifiedCount) fail(401, 'SESSION_EXPIRED');
    await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session: transaction });
  }); ok(res, { requiresLogin: true });
}
