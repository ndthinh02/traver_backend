import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { rateLimit } from 'express-rate-limit';
import { router } from './routes/index.js';
import { errors, ok } from './middleware/http.js';
import { uploadDir } from './controllers/users.js';
export const app = express();
app.disable('x-powered-by'); app.use(helmet());
app.use(rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_r, s) => s.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests' }) }));
app.use(express.json({ limit: '32kb' }));
app.get('/api/health', async (_req, res) => {
  try { if (mongoose.connection.readyState !== 1) throw new Error('Disconnected'); await mongoose.connection.db.admin().ping(); ok(res, { database: 'connected' }); }
  catch { res.status(503).json({ code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' }); }
});
app.use('/uploads', express.static(uploadDir, { dotfiles: 'deny', immutable: true, maxAge: '1d', setHeaders: (res, file) => { if (file.endsWith('.jpg')) res.setHeader('Content-Type', 'image/jpeg'); } }));
app.use('/api', router);
app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Not found' })); app.use(errors);
