import { config } from '../config.js';
import { z } from 'zod';
import { Tour, Review, Booking, Departure } from '../models/index.js';
import { ok, parse, fail, categories, services } from '../middleware/http.js';
export const pageQuery = q => parse(z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(50).default(10) }), q);
const statsStages = [
  { $lookup: { from: 'reviews', let: { id: '$_id' }, pipeline: [{ $match: { ...(config.NODE_ENV === 'production' && {source:'user'}), $expr: { $eq: ['$tourId', '$$id'] } } }, { $group: { _id: null, avg: { $avg: '$stars' }, count: { $sum: 1 } } }], as: 'stats' } },
  { $set: { ratingAverage: { $ifNull: [{ $arrayElemAt: ['$stats.avg', 0] }, 0] }, ratingCount: { $ifNull: [{ $arrayElemAt: ['$stats.count', 0] }, 0] } } },
  { $unset: 'stats' }
];
export async function tourDto(t) {
  const item = t.toObject ? t.toObject() : t;
  if (item.ratingAverage == null) { const stats = await Review.aggregate([{ $match: { tourId: item._id, ...(config.NODE_ENV === 'production' && {source:'user'}) } }, { $group: { _id: null, avg: { $avg: '$stars' }, count: { $sum: 1 } } }]); item.ratingAverage = stats[0]?.avg || 0; item.ratingCount = stats[0]?.count || 0; }
  const { _id, __v, ...rest } = item; return { id: _id, ...rest };
}
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function list(req, res) {
  const v = parse(z.object({
    page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(50).default(10),
    q: z.string().trim().max(100).default(''), category: z.enum(categories).optional(),
    minPrice: z.coerce.number().int().min(0).max(100000000).default(0), maxPrice: z.coerce.number().int().min(0).max(100000000).default(100000000),
    minRating: z.coerce.number().min(0).max(5).default(0), services: z.string().max(100).optional(),
    sort: z.enum(['name', 'price', 'priceDesc', 'rating']).default('name'), featured: z.enum(['true']).optional(), popular: z.enum(['true']).optional()
  }).strict().refine(v => v.minPrice <= v.maxPrice), req.query);
  const match = { published: true, price: { $gte: v.minPrice, $lte: v.maxPrice } };
  if (v.category) match.category = v.category;
  if (v.featured) match.featured = true; if (v.popular) match.popular = true;
  if (v.q) { const regex = new RegExp(escapeRegex(v.q), 'i'); match.$or = ['name', 'location', 'category'].map(k => ({ [k]: regex })); }
  if (v.services) { const required = v.services.split(','); parse(z.array(z.enum(services)).max(5), required); match.services = { $all: required }; }
  const sort = { name: { name: 1, _id: 1 }, price: { price: 1, _id: 1 }, priceDesc: { price: -1, _id: 1 }, rating: { ratingAverage: -1, _id: 1 } }[v.sort];
  const [result] = await Tour.aggregate([{ $match: match }, ...statsStages, { $match: { ratingAverage: { $gte: v.minRating } } }, { $facet: { items: [{ $sort: sort }, { $skip: (v.page - 1) * v.limit }, { $limit: v.limit }], total: [{ $count: 'value' }] } }]);
  const total = result.total[0]?.value || 0;
  ok(res, { items: await Promise.all(result.items.map(tourDto)), page: v.page, limit: v.limit, total, hasMore: v.page * v.limit < total, sort: v.sort });
}
export async function getTour(id) { const tour = await Tour.findOne({ _id: id, published: true }); if (!tour) fail(404, 'TOUR_NOT_FOUND'); return tour; }
export async function detail(req, res) { ok(res, await tourDto(await getTour(req.params.id))); }
export async function related(req, res) { const tour = await getTour(req.params.id); const items = await Tour.find({ _id: { $ne: tour._id }, category: tour.category, published: true }).sort({ name: 1, _id: 1 }).limit(8); ok(res, { items: await Promise.all(items.map(tourDto)) }); }
export async function departures(req, res) { const tour = await getTour(req.params.id); const { page, limit } = pageQuery(req.query); const match = { tourId: tour._id }; const total = await Departure.countDocuments(match); ok(res, { items: await Departure.find(match).select('-_id -__v').sort({ date: 1 }).skip((page - 1) * limit).limit(limit), page, limit, total, hasMore: page * limit < total, timezone: tour.timezone, simulatedBookingOnly: true }); }
export async function getCategories(_req, res) { ok(res, { items: categories }); }
export async function eligibilityFor(user, tourId) {
  if (await Review.exists({ userId: user, tourId })) return { eligible: false, reason: 'ALREADY_REVIEWED' };
  if (!await Booking.exists({ userId: user, tourId, status: 'COMPLETED', source: config.NODE_ENV === 'production' ? 'provider' : {$in:['provider','simulation','development-fixture']} })) return { eligible: false, reason: 'SERVER_BOOKING_REQUIRED' };
  return { eligible: true, reason: 'ELIGIBLE' };
}
export async function eligibility(req, res) { await getTour(req.params.id); ok(res, await eligibilityFor(req.user._id, req.params.id)); }
export async function reviews(req, res) {
  await getTour(req.params.id); const { page, limit } = pageQuery(req.query); const match = { tourId: req.params.id, ...(config.NODE_ENV === 'production' && {source:'user'}) }; const total = await Review.countDocuments(match);
  const entries = await Review.find(match).populate('userId', 'name avatarUrl').sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit);
  ok(res, { items: entries.map(r => ({ id: String(r._id), userId: String(r.userId?._id || ''), tourId: r.tourId, name: r.userId?.name || 'Traveler', avatarUrl: r.userId?.avatarUrl || '', stars: r.stars, text: r.text, createdAt: r.createdAt, source: r.source })), page, limit, total, hasMore: page * limit < total });
}
export async function postReview(req, res) {
  await getTour(req.params.id); const v = parse(z.object({ stars: z.number().int().min(1).max(5), text: z.string().trim().min(10).max(2000) }).strict(), req.body);
  const state = await eligibilityFor(req.user._id, req.params.id); if (!state.eligible) fail(state.reason === 'ALREADY_REVIEWED' ? 409 : 403, state.reason);
  try { const real = await Booking.exists({userId:req.user._id,tourId:req.params.id,status:'COMPLETED',source:'provider'}); await Review.create({ ...v, userId: req.user._id, tourId: req.params.id, source: real ? 'user' : 'simulation' }); } catch (e) { if (e.code === 11000) fail(409, 'ALREADY_REVIEWED'); throw e; }
  // Ratings are derived from Mongo aggregation, never a racing read + increment.
  ok(res, await tourDto(await getTour(req.params.id)));
}
