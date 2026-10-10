import 'dotenv/config';
import { z } from 'zod';
const secret = z.string().min(32).refine(v => !v.startsWith('replace-'), 'Replace placeholder secret');
const schema = z.object({
  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  BOOKING_CLEANUP_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  ENABLE_PAYMENT_SIMULATION: z.enum(['true','false']).default('false').transform(v => v === 'true'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  MONGODB_URI: z.string().min(1), JWT_ACCESS_SECRET: secret, JWT_REFRESH_SECRET: secret, OTP_PEPPER: secret,
  ACCESS_TOKEN_TTL: z.string().regex(/^\d+[smhd]$/).default('15m'),
  REFRESH_TOKEN_TTL: z.string().regex(/^\d+[smhd]$/).default('30d'),
  PUBLIC_BASE_URL: z.url(), NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MAIL_MODE: z.enum(['smtp', 'console']).default('smtp'),
  SMTP_HOST: z.string().default(''), SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().default(''), SMTP_PASS: z.string().default(''), SMTP_FROM: z.string().default('')
});
export const config = schema.parse(process.env);
if (config.NODE_ENV === 'production' && (config.MAIL_MODE !== 'smtp' || !config.PUBLIC_BASE_URL.startsWith('https://'))) throw new Error('Production requires SMTP mode and HTTPS PUBLIC_BASE_URL');
if (new Set([config.JWT_ACCESS_SECRET, config.JWT_REFRESH_SECRET, config.OTP_PEPPER]).size !== 3) throw new Error('Use distinct secrets');
export function ttl(value) { const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 }; return Number(value.slice(0, -1)) * units[value.at(-1)]; }
if (ttl(config.ACCESS_TOKEN_TTL) > 3600000 || ttl(config.REFRESH_TOKEN_TTL) > 90 * 86400000) throw new Error('Token TTL is too long');
