import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Booking, User, Tour } from '../src/models/index.js';
if (config.NODE_ENV !== 'development') throw new Error('Development only');
const email = process.argv[2]?.trim().toLowerCase(); const tourId = process.argv[3] || 'tour-1';
if (!email) throw new Error('Usage: npm run seed:eligible -- test-user-email [tour-id]');
try { await mongoose.connect(config.MONGODB_URI); const user = await User.findOne({ email }); if (!user || !await Tour.exists({ _id: tourId })) throw new Error('User/tour must exist'); await Booking.updateOne({ userId: user._id, tourId, source: 'development-fixture' }, { $setOnInsert: { userId: user._id, tourId, status: 'COMPLETED', source: 'development-fixture' } }, { upsert: true }); console.info('Development eligibility fixture inserted'); }
finally { await mongoose.disconnect(); }
