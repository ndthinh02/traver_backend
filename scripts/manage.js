import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { Tour, Departure, Booking } from '../src/models/index.js';
import { transaction, zonedMidnight, addDate, validDate, initializeBookings, completeDue } from '../src/services/bookings.js';
if(config.NODE_ENV!=='development')throw new Error('Development management only');
const [action,id,date,capacityArg,statusArg]=process.argv.slice(2);
try {
 await mongoose.connect(config.MONGODB_URI);await initializeBookings();await Promise.all([Departure.init(),Booking.init()]);
 if(action==='departure') {
  const capacity=Number(capacityArg),status=statusArg||'open';
  if(!id||!validDate(date)||!Number.isInteger(capacity)||capacity<0||capacity>10000||!['open','closed'].includes(status))throw new Error('Usage: npm run manage -- departure tour-id YYYY-MM-DD capacity [open|closed]');
  const tour=await Tour.findById(id);if(!tour)throw new Error('Tour missing');
  await transaction(async session=>{const d=await Departure.findOne({tourId:id,date}).session(session);if(d){if(capacity<d.heldSeats+d.bookedSeats)throw new Error('Capacity below reserved seats');d.capacity=capacity;d.status=status;await d.save({session});}else await Departure.create([{tourId:id,date,capacity,status,heldSeats:0,bookedSeats:0,timezone:tour.timezone,startsAt:zonedMidnight(date,tour.timezone),endsAt:zonedMidnight(addDate(date,tour.days),tour.timezone)}],{session});});
  console.info('Departure updated');
 } else if(action==='complete') {
  if(!mongoose.isValidObjectId(id))throw new Error('Usage: npm run manage -- complete booking-id');
  await transaction(async session=>{const b=await Booking.findOne({_id:id,source:'simulation',status:'CONFIRMED'}).session(session);if(!b)throw new Error('Confirmed simulation booking required');b.endsAt=new Date(Date.now()-1000);b.events.push({id:crypto.randomUUID(),type:'DEV_END_TIME_OVERRIDE',at:new Date(),actor:'development-cli',note:'Specific simulation lifecycle fixture'});await b.save({session});});await completeDue();console.info('Specific simulation completed');
 } else throw new Error('Actions: departure | complete');
} finally {await mongoose.disconnect();}