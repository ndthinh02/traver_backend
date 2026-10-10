import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from '../config.js';
import { User, Favorite, Tour } from '../models/index.js';
import { ok, parse, fail, categories } from '../middleware/http.js';
import { publicUser } from '../services/session.js';
import { pageQuery, tourDto } from './catalog.js';
export const uploadDir = path.resolve('uploads');
export async function me(req, res) { ok(res, publicUser(req.user)); }
export async function patchMe(req, res) {
  const v = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), phone: z.string().trim().max(32).refine(p => !p || p.replace(/\D/g, '').length >= 8).optional(), interests: z.array(z.enum(categories)).max(6).optional() }).strict(), req.body);
  ok(res, publicUser(await User.findByIdAndUpdate(req.user._id, { $set: v }, { new: true, runValidators: true })));
}
export async function avatar(req, res) {
  if (!req.file || !['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype)) fail(400, 'AVATAR_INVALID');
  let output;
  try { const image = sharp(req.file.buffer, { limitInputPixels: 16000000 }); const meta = await image.metadata(); if (!['jpeg', 'png', 'webp'].includes(meta.format) || meta.pages > 1) fail(400, 'AVATAR_INVALID'); output = await image.resize(512, 512, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); }
  catch { fail(400, 'AVATAR_INVALID'); }
  await fs.mkdir(uploadDir, { recursive: true });
  const filename = `${crypto.randomUUID()}.jpg`; const target = path.join(uploadDir, filename); await fs.writeFile(target, output, { flag: 'wx' });
  const url = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/uploads/${filename}`;
  try { const u = await User.findByIdAndUpdate(req.user._id, { $set: { avatarUrl: url } }, { new: true }); ok(res, publicUser(u)); }
  catch (e) { await fs.unlink(target); throw e; }
}
export async function favorites(req, res) {
  const { page, limit } = pageQuery(req.query);
  const [result] = await Favorite.aggregate([{ $match: { userId: req.user._id } },
    { $lookup: { from: 'tours', localField: 'tourId', foreignField: '_id', as: 'tour' } },
    { $unwind: '$tour' }, { $match: { 'tour.published': true } },
    { $facet: { items: [{ $sort: { createdAt: -1, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'value' }] } }]);
  const total = result.total[0]?.value || 0;
  const items = await Promise.all(result.items.map(e => tourDto(e.tour)));
  ok(res, { items, page, limit, total, hasMore: page * limit < total });
}
export async function putFavorite(req, res) {
  if (!await Tour.exists({ _id: req.params.tourId, published: true })) fail(404, 'TOUR_NOT_FOUND');
  try { await Favorite.updateOne({ userId: req.user._id, tourId: req.params.tourId }, { $setOnInsert: { userId: req.user._id, tourId: req.params.tourId } }, { upsert: true }); } catch (e) { if (e.code !== 11000) throw e; } ok(res);
}
export async function deleteFavorite(req, res) { await Favorite.deleteOne({ userId: req.user._id, tourId: req.params.tourId }); ok(res); }
