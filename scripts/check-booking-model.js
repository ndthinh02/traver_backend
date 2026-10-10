import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Booking } from '../src/models/index.js';
// Regression: a field named "type" in an inline array definition became Array<String>.
assert.equal(Booking.schema.path('events').$isMongooseDocumentArray, true);
const userId = new mongoose.Types.ObjectId();
const booking = new Booking({ userId, tourId: 'tour-0', status: 'PENDING_PAYMENT', source: 'simulation' });
for (const type of ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'COMPLETED']) {
  const at = new Date();
  assert.doesNotThrow(() => booking.events.push({ id: `regression-${type}`, type, at, actor: String(userId), note: 'test event' }));
  const event = booking.events.at(-1);
  assert.equal(event.type, type);
  assert.equal(event.at.getTime(), at.getTime());
  assert.equal(event.actor, String(userId));
  assert.equal(event._id, undefined);
}
assert.equal(booking.validateSync(), undefined);
const restored = Booking.hydrate(booking.toObject());
assert.equal(restored.events.length, 6);
assert.equal(restored.events[2].type, 'CONFIRMED');
assert.equal(restored.validateSync(), undefined);
restored.events.push({ id: 'bad-date', type: 'CONFIRMED', at: 'invalid-date', actor: String(userId) });
assert(restored.validateSync()?.errors['events.6.at']);
console.info('Booking event regression passed: object events, serialization/hydration and date validation (no DB).');