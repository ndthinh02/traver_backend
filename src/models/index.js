import mongoose from 'mongoose';
const { Schema, model } = mongoose;
const userSchema = new Schema({
  email: { type: String, required: true, unique: true }, passwordHash: { type: String, required: true, select: false },
  name: { type: String, required: true }, phone: { type: String, default: '' }, avatarUrl: { type: String, default: '' },
  interests: { type: [String], default: [] }, emailVerifiedAt: Date,
  status: { type: String, enum: ['active', 'disabled'], default: 'active' }, sessionVersion: { type: Number, default: 0, select: false }
}, { timestamps: true });
export const User = model('User', userSchema);
const challengeSchema = new Schema({
  email: { type: String, required: true }, purpose: { type: String, enum: ['register', 'reset'], required: true },
  digest: { type: String, select: false }, passwordHash: { type: String, select: false }, name: String,
  attempts: { type: Number, default: 0 }, lockUntil: Date, expiresAt: Date, resendAt: Date, consumedAt: Date,
  resetHash: { type: String, select: false }, resetExpiresAt: Date, resetUsedAt: Date,
  cleanupAt: { type: Date, expires: 0 }
}, { timestamps: true });
challengeSchema.index({ email: 1, purpose: 1 }, { unique: true });
export const Challenge = model('Challenge', challengeSchema);
const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  refreshHash: { type: String, select: false }, expiresAt: Date, revokedAt: Date,
  version: Number, cleanupAt: { type: Date, expires: 0 }
}, { timestamps: true });
export const Session = model('Session', sessionSchema);
const tourSchema = new Schema({
  _id: String, slug: { type: String, unique: true }, name: String, category: String, location: String,
  lat: Number, lon: Number, image: String, gallery: [String], assetNote: String,
  description: String, descriptionVi: String, itinerary: [String], itineraryVi: [String], services: [String],
  days: Number, price: Number, childPrice: Number, fee: Number, currency: { type: String, default: 'USD' },
  cancelDays: Number, timezone: { type: String, default: 'Asia/Jakarta' }, capacity: Number,
  published: { type: Boolean, default: true }, featured: Boolean, popular: Boolean
}, { timestamps: true });
tourSchema.index({ published: 1, category: 1, price: 1, _id: 1 });
export const Tour = model('Tour', tourSchema);
const departureSchema = new Schema({ tourId: { type: String, ref: 'Tour', required: true }, date: { type: String, required: true }, timezone: String, startsAt: Date, endsAt: Date, capacity: { type: Number, min: 0, max:10000, required: true }, heldSeats: { type: Number, min: 0, default: 0 }, bookedSeats: { type: Number, min: 0, default: 0 }, status: { type: String, enum: ['open','closed'], default: 'open' } }, { timestamps: true });
departureSchema.pre('validate',function(){ if(!Number.isSafeInteger(this.capacity)||!Number.isSafeInteger(this.heldSeats)||!Number.isSafeInteger(this.bookedSeats)||this.heldSeats+this.bookedSeats>this.capacity)this.invalidate('capacity','Invalid seat counters'); });
departureSchema.index({ tourId: 1, date: 1 }, { unique: true });
export const Departure = model('Departure', departureSchema);
const favoriteSchema = new Schema({ userId: { type: Schema.Types.ObjectId, ref: 'User' }, tourId: { type: String, ref: 'Tour' } }, { timestamps: true });
favoriteSchema.index({ userId: 1, tourId: 1 }, { unique: true });
export const Favorite = model('Favorite', favoriteSchema);
const reviewSchema = new Schema({ userId: { type: Schema.Types.ObjectId, ref: 'User' }, tourId: { type: String, ref: 'Tour' }, stars: { type: Number, min: 1, max: 5 }, text: String, source: { type: String, default: 'user' } }, { timestamps: true });
reviewSchema.index({ userId: 1, tourId: 1 }, { unique: true });
export const Review = model('Review', reviewSchema);
const bookingEventSchema = new Schema({
 id: { type: String, required: true }, type: { type: String, required: true },
 at: { type: Date, required: true }, actor: { type: String, required: true }, note: String
}, { _id: false });
const bookingSchema = new Schema({
 userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, tourId: { type: String, ref: 'Tour', required: true },
 departureId: { type: Schema.Types.ObjectId, ref: 'Departure' }, code: String, idempotencyKey: String, payloadHash: String,
 snapshot: { name: String, image: String, days: Number, services: [String], currency: String, cancelDays: Number, timezone: String },
 adults: Number, children: Number, contact: { name: String, email: String, phone: String },
 price: { adultPrice: Number, childPrice: Number, adultsSubtotal: Number, childrenSubtotal: Number, fee: Number, total: Number, currency: String },
 date: String, endDate: String, startsAt: Date, endsAt: Date, holdExpiresAt: Date,
 status: { type: String, enum: ['PENDING_PAYMENT','CONFIRMED','EXPIRED','CANCELLED','COMPLETED'], required: true },
 paymentStatus: { type: String, enum: ['UNPAID','FAILED','SIMULATED_PAID','CANCELLED'], default: 'UNPAID' },
 source: { type: String, enum: ['simulation','development-fixture','provider'], required: true },
 paymentMode: { type: String, enum: ['simulation','unavailable','provider'], default: 'unavailable' }, method: String,
 events: { type: [bookingEventSchema], default: [] }
}, { timestamps: true });
bookingSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
bookingSchema.index({userId:1,tourId:1,source:1},{unique:true,partialFilterExpression:{source:'development-fixture'}});
bookingSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
bookingSchema.index({ status: 1, holdExpiresAt: 1 });
bookingSchema.index({ userId: 1, createdAt: -1, _id: 1 });
export const Booking = model('Booking', bookingSchema);
const notificationSchema = new Schema({ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' }, eventId: { type: String, unique: true }, type: String, title: String, titleVi: String, body: String, bodyVi: String, read: { type: Boolean, default: false } }, { timestamps: true });
notificationSchema.index({ userId: 1, createdAt: -1, _id: 1 });
export const Notification = model('Notification', notificationSchema);

export const AuthThrottle = model('AuthThrottle', new Schema({ _id: String, count: { type: Number, default: 0 }, expiresAt: { type: Date, expires: 0 } }));
