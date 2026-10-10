import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
export class ApiError extends Error { constructor(status, code, fieldErrors) { super(code); this.status = status; this.code = code; this.fieldErrors = fieldErrors; } }
export const fail = (status, code) => { throw new ApiError(status, code); };
export const ok = (res, data = {}) => res.json({ code: 'OK', message: 'OK', data });
export const parse = (schema, input) => schema.parse(input);
export const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const password = z.string().min(8).max(72).refine(v => Buffer.byteLength(v, 'utf8') <= 72);
export const objectId = z.string().regex(/^[a-f\d]{24}$/i);
export const categories = ['Beach', 'Mountain', 'Forest', 'Ocean', 'Camping', 'Fishing'];
export const services = ['Hotel', 'Meals', 'Guide', 'Flight', 'Transfer'];
export const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 50, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, res) => res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests' }) });
export function errors(err, _req, res, _next) {
  if (err instanceof z.ZodError) return res.status(400).json({ code: 'VALIDATION', message: 'Invalid input', fieldErrors: z.flattenError(err).fieldErrors });
  if (err.code === 11000) return res.status(409).json({ code: 'CONFLICT', message: 'Already exists' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ code: 'AVATAR_TOO_LARGE', message: 'Image too large' });
  if (err.status) return res.status(err.status).json({ code: err.code || 'BAD_REQUEST', message: err.code || 'Invalid request', ...(err.fieldErrors && { fieldErrors: err.fieldErrors }), ...(err.data && { data: err.data }) });
  console.error('Request failed:', err.name); // Never log body, credentials, PII or stack.
  res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' });
}
