import mongoose from 'mongoose';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Booking, Departure, Tour, Notification } from '../models/index.js';
import { config } from '../config.js';
import { fail, ApiError } from '../middleware/http.js';

export const simulationEnabled = () => config.NODE_ENV !== 'production' && config.ENABLE_PAYMENT_SIMULATION;
export function addDate(date, days) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0,10); }
export function validDate(date) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) === date; }
// Calendar conversion in the tour timezone, including changes of UTC offset (DST).
export function zonedMidnight(date, timezone) {
  if (!validDate(date)) fail(400,'DEPARTURE_CLOSED');
  const target = Date.parse(`${date}T00:00:00Z`); let candidate = target;
  const fmt = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for (let n=0;n<4;n++) { const p = Object.fromEntries(fmt.formatToParts(new Date(candidate)).map(v=>[v.type,v.value])); const represented = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second); const delta=target-represented; if (!delta) break; candidate+=delta; }
  return new Date(candidate);
}
export async function transaction(work) {
  const session = await mongoose.startSession();
  try {
    for(let attempt=0;attempt<5;attempt++) {
      session.startTransaction({ readConcern: { level:'snapshot' }, writeConcern: { w:'majority' }, maxCommitTimeMS:10000 });
      try {
        const result = await work(session);
        for(let commit=0;;commit++) { try { await session.commitTransaction(); break; } catch(e) { if(commit<2 && e.hasErrorLabel?.('UnknownTransactionCommitResult')) continue; throw e; } }
        return result;
      } catch(e) { if(session.inTransaction()) await session.abortTransaction(); if(attempt<4 && e.hasErrorLabel?.('TransientTransactionError')) continue; throw e; }
    }
  } finally { await session.endSession(); }
}
const titles = {
 PENDING_PAYMENT: ['Reservation held','Đã giữ chỗ'], CONFIRMED:['Booking confirmed (test payment)','Đã xác nhận đơn (thanh toán thử)'],
 EXPIRED:['Reservation expired','Đã hết hạn giữ chỗ'], CANCELLED:['Booking cancelled','Đã hủy chuyến'], COMPLETED:['Trip completed','Chuyến đi hoàn thành'],
 PAYMENT_FAILED:['Test payment failed','Thanh toán thử thất bại'], PAYMENT_CANCELLED:['Test payment stopped','Đã dừng thanh toán thử']
};
async function event(b, type, actor, session, note='') {
 const id=crypto.randomUUID(), at=new Date(); b.events.push({id,type,at,actor,note});
 const [title,titleVi]=titles[type] || [type,type];
 await Notification.create([{userId:b.userId,bookingId:b._id,eventId:id,type,title,titleVi,body:`${b.code || 'Booking'} — ${type}`,bodyVi:`${b.code || 'Đơn'} — ${type}`}],{session});
}
async function release(b, terminal, session, actor='worker') {
 const seats=b.adults+b.children, counter=b.status==='PENDING_PAYMENT'?'heldSeats':'bookedSeats';
 const result=await Departure.updateOne({_id:b.departureId,[counter]:{$gte:seats}},{$inc:{[counter]:-seats}},{session});
 if(result.modifiedCount!==1) throw new Error('Seat counter invariant');
 b.status=terminal; b.paymentStatus='CANCELLED';
 await event(b,terminal,actor,session,b.source==='simulation'?'Simulation only; no funds transferred':''); await b.save({session});
}
export async function expireHolds(departureId, {tourId,userId,maxBatches=20,shouldStop=()=>false}={}) {
 const match={status:'PENDING_PAYMENT',holdExpiresAt:{$lte:new Date()},...(departureId && {departureId}),...(tourId && {tourId}),...(userId && {userId})};let total=0;
 for(let batch=0;batch<maxBatches && !shouldStop();batch++) {
 const ids=await Booking.find(match).select('_id').limit(500).lean();
 for(const entry of ids) {if(shouldStop())break;await transaction(async session=>{
   const b=await Booking.findOne({_id:entry._id,...match}).session(session); if(b) await release(b,'EXPIRED',session);
 });}
 total+=ids.length;if(ids.length<500)break;
 }return total;
}
export async function completeDue(shouldStop=()=>false) {
 const ids=await Booking.find({status:'CONFIRMED',endsAt:{$lte:new Date()}}).select('_id').limit(200).lean();
 for(const entry of ids) {if(shouldStop())break;await transaction(async session=>{const b=await Booking.findOne({_id:entry._id,status:'CONFIRMED',endsAt:{$lte:new Date()}}).session(session); if(!b)return; b.status='COMPLETED'; await event(b,'COMPLETED','worker',session); await b.save({session});});}
}
let timer, running, stopping=false;
export function startWorker() {
 stopping=false; const tick=()=>{if(stopping||running)return; running=(async()=>{await expireHolds(undefined,{maxBatches:1,shouldStop:()=>stopping});await completeDue(()=>stopping);})().catch(e=>console.error('Booking worker failed:',e.name)).finally(()=>{running=null;});};
 tick(); timer=setInterval(tick,config.BOOKING_CLEANUP_SECONDS*1000); timer.unref();
}
export async function stopWorker() {stopping=true;clearInterval(timer); if(running)await running;}
export async function initializeBookings() {
 // Remove only the phase-1 unique index that disallowed a second trip on the same tour.
 let indexes=[];try{indexes=await Booking.collection.indexes();}catch(e){if(e.code!==26)throw e;} const old=indexes.find(i=>i.unique && i.key.userId===1 && i.key.tourId===1 && Object.keys(i.key).length===2);
 if(old)try{await Booking.collection.dropIndex(old.name);}catch(e){if(e.code!==27 && e.code!==26)throw e;}
 // Phase-1 development fixtures could have created reviews labeled 'user'. Keep them out of production.
 const reviews = mongoose.model('Review');
 const samples=await reviews.aggregate([{ $match:{source:'user'} },{ $lookup:{from:'bookings',let:{u:'$userId',t:'$tourId'},pipeline:[{$match:{$expr:{$and:[{$eq:['$userId','$$u']},{$eq:['$tourId','$$t']}]}}}],as:'provenance'} },{ $match:{'provenance.source':'development-fixture','provenance':{$not:{$elemMatch:{source:'provider',status:'COMPLETED'}}}} },{$project:{_id:1}}]);
 if(samples.length)await reviews.updateMany({_id:{$in:samples.map(r=>r._id)}},{$set:{source:'simulation'}});
 for await (const d of Departure.find({$or:[{startsAt:{$exists:false}},{heldSeats:{$exists:false}},{status:{$exists:false}}]}).cursor()) {
   const t=await Tour.findById(d.tourId); if(!t)continue;
   const timezone=d.timezone||t.timezone; const startsAt=d.startsAt||zonedMidnight(d.date,timezone); const endsAt=d.endsAt||zonedMidnight(addDate(d.date,t.days),timezone);
   await Departure.updateOne({_id:d._id},{$set:{timezone,startsAt,endsAt}});
   await Departure.updateOne({_id:d._id,heldSeats:{$exists:false}},{$set:{heldSeats:0}});
   await Departure.updateOne({_id:d._id,bookedSeats:{$exists:false}},{$set:{bookedSeats:0}});
   await Departure.updateOne({_id:d._id,status:{$exists:false}},{$set:{status:'open'}});
 }
}
export function priceFor(t,adults,children) {
 if(!Number.isInteger(adults)||!Number.isInteger(children)||adults<1||children<0||adults+children>20)fail(400,'INVALID_PARTICIPANTS');
 const price={adultPrice:t.price,childPrice:t.childPrice,adultsSubtotal:t.price*adults,childrenSubtotal:t.childPrice*children,fee:t.fee,currency:t.currency};
 price.total=price.adultsSubtotal+price.childrenSubtotal+price.fee;
 if(price.currency!=='USD'||Object.values(price).some(v=>typeof v==='number' && (!Number.isSafeInteger(v)||v<0||v>100000000)))fail(503,'INVALID_PRICE');
 return price;
}
const priceHash = (t,p) => crypto.createHash('sha256').update(JSON.stringify([p,t.days,t.cancelDays,t.timezone])).digest('hex');
const quoteSecret = crypto.createHmac('sha256',config.JWT_ACCESS_SECRET).update('traver-booking-quote-v1').digest('hex');
export async function openDeparture(id, session) {
 const d=await Departure.findById(id).session(session||null); if(!d||d.status!=='open'||!d.startsAt||d.startsAt<=new Date())fail(409,'DEPARTURE_CLOSED');
 const t=await Tour.findOne({_id:d.tourId,published:true}).session(session||null); if(!t)fail(409,'DEPARTURE_CLOSED'); return {d,t};
}
export function quoteDto(d,t,adults,children,user) {
 const price=priceFor(t,adults,children);
 const quoteToken=jwt.sign({purpose:'booking-quote',user:String(user),departureId:String(d._id),adults,children,version:priceHash(t,price)},quoteSecret,{expiresIn:'15m',algorithm:'HS256'});
 return {price,quoteToken,policy:{cancelDays:t.cancelDays,holdMinutes:config.BOOKING_HOLD_MINUTES},departureId:String(d._id),date:d.date,timezone:d.timezone,remaining:d.capacity-d.heldSeats-d.bookedSeats,serverTime:new Date(),paymentSimulationEnabled:simulationEnabled()};
}
export async function quote(user,v) { await expireHolds(v.departureId); const {d,t}=await openDeparture(v.departureId); const q=quoteDto(d,t,v.adults,v.children,user); if(q.remaining<v.adults+v.children)fail(409,'SOLD_OUT'); return q; }
function verifyQuote(v,user,t,p) {
 let token;try{token=jwt.verify(v.quoteToken,quoteSecret,{algorithms:['HS256']});}catch{fail(409,'QUOTE_EXPIRED');}
 if(token.purpose!=='booking-quote'||token.user!==String(user)||token.departureId!==v.departureId||token.adults!==v.adults||token.children!==v.children)fail(400,'INVALID_QUOTE');
 if(token.version!==priceHash(t,p)) {const e=new ApiError(409,'PRICE_CHANGED');e.data={price:p};throw e;}
}
export function bookingDto(b) {
 const o=b.toObject?b.toObject():b; const {_id,__v,payloadHash,idempotencyKey,...rest}=o;
 return {id:String(_id),...rest,userId:String(o.userId),departureId:o.departureId?String(o.departureId):null,serverTime:new Date(),paymentSimulationEnabled:simulationEnabled() && o.paymentMode==='simulation',canCancel:o.status==='PENDING_PAYMENT'||(o.status==='CONFIRMED' && new Date()<zonedMidnight(addDate(o.date,-(o.snapshot?.cancelDays||0)),o.snapshot.timezone))};
}
export async function createBooking(user,v) {
 const normalized={departureId:v.departureId,adults:v.adults,children:v.children,contact:v.contact,method:v.method};
 const hash=crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
 const existing=await Booking.findOne({userId:user,idempotencyKey:v.idempotencyKey});
 if(existing){if(existing.payloadHash!==hash)fail(409,'IDEMPOTENCY_CONFLICT');await expireHolds(existing.departureId);return bookingDto(await Booking.findById(existing._id));}
 await expireHolds(v.departureId);
 try {return await transaction(async session=>{
   const prior=await Booking.findOne({userId:user,idempotencyKey:v.idempotencyKey}).session(session); if(prior){if(prior.payloadHash!==hash)fail(409,'IDEMPOTENCY_CONFLICT');return bookingDto(prior);}
   const {d,t}=await openDeparture(v.departureId,session);const price=priceFor(t,v.adults,v.children);verifyQuote(v,user,t,price); const seats=v.adults+v.children;
   const held=await Departure.updateOne({_id:d._id,status:'open',startsAt:{$gt:new Date()},$expr:{$lte:[{$add:['$heldSeats','$bookedSeats',seats]},'$capacity']}},{$inc:{heldSeats:seats}},{session});
   if(held.modifiedCount!==1)fail(409,'SOLD_OUT');
   const now=new Date();const b=new Booking({userId:user,tourId:t._id,departureId:d._id,code:`TRV-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,idempotencyKey:v.idempotencyKey,payloadHash:hash,
    snapshot:{name:t.name,image:t.image,days:t.days,services:t.services,currency:t.currency,cancelDays:t.cancelDays,timezone:d.timezone}, adults:v.adults,children:v.children,contact:v.contact,price,
    date:d.date,endDate:addDate(d.date,t.days-1),startsAt:d.startsAt,endsAt:d.endsAt,holdExpiresAt:new Date(Math.min(now.getTime()+config.BOOKING_HOLD_MINUTES*60000,d.startsAt.getTime())),status:'PENDING_PAYMENT',paymentStatus:'UNPAID',source:'simulation',paymentMode:simulationEnabled()?'simulation':'unavailable',method:v.method,events:[]});
   await event(b,'PENDING_PAYMENT',String(user),session);await b.save({session});return bookingDto(b);
 });}catch(e){if(e.code===11000){const b=await Booking.findOne({userId:user,idempotencyKey:v.idempotencyKey});if(b){if(b.payloadHash!==hash)fail(409,'IDEMPOTENCY_CONFLICT');return bookingDto(b);}}throw e;}
}
export async function owned(id,user) {const b=await Booking.findOne({_id:id,userId:user});if(!b)fail(404,'BOOKING_NOT_FOUND');return b;}
export async function detail(id,user) {const b=await owned(id,user);if(b.departureId)await expireHolds(b.departureId);return bookingDto(await owned(id,user));}
export async function payment(id,user,result) {
 if(!simulationEnabled())fail(403,'PAYMENT_UNAVAILABLE'); const b=await owned(id,user);await expireHolds(b.departureId);
 return transaction(async session=>{
  const current=await Booking.findOne({_id:id,userId:user}).session(session);if(!current)fail(404,'BOOKING_NOT_FOUND');
  if(current.source!=='simulation'||current.paymentMode!=='simulation')fail(403,'PAYMENT_UNAVAILABLE');
  if(current.status==='CONFIRMED'||current.status==='COMPLETED'){if(result==='success')return bookingDto(current);fail(409,'INVALID_BOOKING_STATE');}
  if(current.status==='EXPIRED'||current.holdExpiresAt<=new Date())fail(409,'HOLD_EXPIRED');if(current.status!=='PENDING_PAYMENT')fail(409,'INVALID_BOOKING_STATE');
  if(result==='success') {const seats=current.adults+current.children; const changed=await Departure.updateOne({_id:current.departureId,heldSeats:{$gte:seats}},{$inc:{heldSeats:-seats,bookedSeats:seats}},{session});if(changed.modifiedCount!==1)throw new Error('Seat counter invariant');current.status='CONFIRMED';current.paymentStatus='SIMULATED_PAID';await event(current,'CONFIRMED',String(user),session);}
  else {const next=result==='failure'?'FAILED':'CANCELLED'; if(current.paymentStatus!==next){current.paymentStatus=next;await event(current,result==='failure'?'PAYMENT_FAILED':'PAYMENT_CANCELLED',String(user),session);}}
  await current.save({session});return bookingDto(current);
 });
}
export async function cancel(id,user,reason='') {
 const b=await owned(id,user);if(b.departureId)await expireHolds(b.departureId);
 return transaction(async session=>{const current=await Booking.findOne({_id:id,userId:user}).session(session);if(!current)fail(404,'BOOKING_NOT_FOUND');if(current.status==='CANCELLED')return bookingDto(current);
  if(current.status==='EXPIRED')fail(409,'HOLD_EXPIRED');if(!['PENDING_PAYMENT','CONFIRMED'].includes(current.status))fail(409,'INVALID_BOOKING_STATE');
  if(current.status==='CONFIRMED' && new Date()>=zonedMidnight(addDate(current.date,-current.snapshot.cancelDays),current.snapshot.timezone))fail(409,'CANCELLATION_NOT_ALLOWED');
  await release(current,'CANCELLED',session,String(user)); if(reason){current.events[current.events.length-1].note=reason;await current.save({session});}return bookingDto(current);
 });
}