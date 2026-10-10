import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config, ttl } from '../config.js';
import { Session, User } from '../models/index.js';
import { fail } from '../middleware/http.js';
export const hash = v => crypto.createHash('sha256').update(v).digest('hex');
export const publicUser = u => ({ id: String(u._id), email: u.email, name: u.name, phone: u.phone, avatarUrl: u.avatarUrl, interests: u.interests, emailVerifiedAt: u.emailVerifiedAt });
function tokens(user, session) {
  const claims = { sub: String(user._id), sid: String(session._id), ver: user.sessionVersion };
  return { accessToken: jwt.sign({ ...claims, kind: 'access' }, config.JWT_ACCESS_SECRET, { expiresIn: config.ACCESS_TOKEN_TTL, issuer: 'traver', audience: 'traver-android' }),
    refreshToken: jwt.sign({ ...claims, kind: 'refresh', nonce: crypto.randomUUID() }, config.JWT_REFRESH_SECRET, { expiresIn: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)), issuer: 'traver', audience: 'traver-android' }), user: publicUser(user) };
}
export async function issueSession(user, transaction) {
  const session = new Session({ userId: user._id, version: user.sessionVersion, expiresAt: new Date(Date.now() + ttl(config.REFRESH_TOKEN_TTL)), cleanupAt: new Date(Date.now() + ttl(config.REFRESH_TOKEN_TTL) + 86400000) });
  const result = tokens(user, session); session.refreshHash = hash(result.refreshToken); await session.save({ session: transaction }); return result;
}
function decode(token, kind) {
  try { const c = jwt.verify(token, kind === 'access' ? config.JWT_ACCESS_SECRET : config.JWT_REFRESH_SECRET, { algorithms: ['HS256'], issuer: 'traver', audience: 'traver-android' });
    if (c.kind !== kind || !/^[a-f\d]{24}$/i.test(c.sid) || !/^[a-f\d]{24}$/i.test(c.sub)) fail(401, 'SESSION_EXPIRED'); return c;
  } catch { fail(401, 'SESSION_EXPIRED'); }
}
export async function auth(req, _res, next) {
  const c = decode((req.headers.authorization || '').replace(/^Bearer /, ''), 'access');
  const [user, session] = await Promise.all([User.findById(c.sub).select('+sessionVersion'), Session.findOne({ _id: c.sid, userId: c.sub })]);
  if (!user || user.status !== 'active' || !session || session.revokedAt || session.expiresAt <= new Date() || user.sessionVersion !== c.ver || session.version !== c.ver) fail(401, 'SESSION_EXPIRED');
  req.user = user; req.sessionId = c.sid; next();
}
export async function refresh(token) {
  const c = decode(token, 'refresh');
  const user = await User.findById(c.sub).select('+sessionVersion');
  const session = await Session.findOne({ _id: c.sid, userId: c.sub }).select('+refreshHash');
  if (!user || !session || user.status !== 'active' || session.revokedAt || session.expiresAt <= new Date() || user.sessionVersion !== c.ver) fail(401, 'SESSION_EXPIRED');
  if (session.refreshHash !== hash(token)) { await Session.updateOne({ _id: c.sid }, { $set: { revokedAt: new Date() } }); fail(401, 'REFRESH_REUSED'); }
  const result = tokens(user, session);
  const updated = await Session.updateOne({ _id: c.sid, refreshHash: hash(token), revokedAt: null }, { $set: { refreshHash: hash(result.refreshToken) } });
  if (!updated.modifiedCount) { await Session.updateOne({ _id: c.sid }, { $set: { revokedAt: new Date() } }); fail(401, 'REFRESH_REUSED'); }
  return result;
}
