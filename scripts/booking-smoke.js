import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { app } from '../src/app.js';
import { User, Tour, Departure, Booking, Notification, Session, Review } from '../src/models/index.js';
import { issueSession } from '../src/services/session.js';
import { expireHolds, completeDue, initializeBookings, startWorker, stopWorker, zonedMidnight, addDate } from '../src/services/bookings.js';
if(config.NODE_ENV!=='development'||!config.ENABLE_PAYMENT_SIMULATION||config.MAIL_MODE!=='console'||!config.MONGODB_URI.split('?')[0].split('/').at(-1).endsWith('_smoke'))throw new Error('Requires dedicated *_smoke DB, development, console and explicit simulation flag');
const prefix=`booking-smoke-${Date.now()}`,tourId=prefix;let server;let users=[];let base;
async function call(path,token,body,method=body?'POST':'GET',status=200) {
 const response=await fetch(`${base}/api/${path}`,{method,headers:{...(token&&{Authorization:`Bearer ${token}`}),...(body&&{'Content-Type':'application/json'})},...(body&&{body:JSON.stringify(body)})});const j=await response.json();if(status!==null)assert.equal(response.status,status,`${path}: ${j.code}`);return {status:response.status,code:j.code,data:j.data};
}
const payload=(d,q,key=crypto.randomUUID())=>({departureId:String(d._id),adults:1,children:0,contact:{name:'Smoke contact',email:'test@example.test',phone:'0900000000'},method:'Card',quoteToken:q.quoteToken,idempotencyKey:key});
try {
 console.info('Connecting to isolated smoke database'); await mongoose.connect(config.MONGODB_URI,{serverSelectionTimeoutMS:10000,connectTimeoutMS:10000,socketTimeoutMS:20000});console.info('Connected; initializing booking indexes');await initializeBookings();await Promise.all([User,Tour,Departure,Booking,Notification,Session,Review].map(m=>m.init()));
 const passwordHash=await bcrypt.hash('BookingSmoke123',4);users=await User.create(['a','b'].map(n=>({email:`${prefix}-${n}@example.test`,name:`Smoke ${n}`,passwordHash,emailVerifiedAt:new Date(),sessionVersion:0})));
 const [A,B]=await Promise.all(users.map(u=>issueSession(u)));const a=A.accessToken,b=B.accessToken;
 const tour=await Tour.create({_id:tourId,slug:tourId,name:'Smoke tour',category:'Beach',price:10000,childPrice:6000,fee:1500,currency:'USD',days:2,cancelDays:1,timezone:'America/New_York',published:true,image:'kuta',services:['Guide']});
 const date=addDate(new Date().toISOString().slice(0,10),10);
 const d=await Departure.create({tourId,date,timezone:tour.timezone,capacity:1,heldSeats:0,bookedSeats:0,status:'open',startsAt:zonedMidnight(date,tour.timezone),endsAt:zonedMidnight(addDate(date,2),tour.timezone)});
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 const quote=async(token,dpt=d)=>(await call('bookings/quote',token,{departureId:String(dpt._id),adults:1,children:0})).data;
 const qA=await quote(a),qB=await quote(b);const pa=payload(d,qA),pb=payload(d,qB);
 const race=await Promise.all([call('bookings',a,pa,'POST',null),call('bookings',b,pb,'POST',null)]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);assert.equal(race.find(r=>r.status===409).code,'SOLD_OUT');
 const winner=race[0].status===200?{token:a,p:pa,booking:race[0].data,other:b}:{token:b,p:pb,booking:race[1].data,other:a};
 const retry=await call('bookings',winner.token,winner.p);assert.equal(retry.data.id,winner.booking.id);assert.equal((await Departure.findById(d._id)).heldSeats,1);assert.equal(await Booking.countDocuments({tourId}),1);
 assert.equal((await call('bookings',winner.token,{...winner.p,contact:{...winner.p.contact,name:'Changed'}},'POST',409)).code,'IDEMPOTENCY_CONFLICT');
 for(const route of [`bookings/${winner.booking.id}`,`bookings/${winner.booking.id}/ticket`])await call(route,winner.other,null,'GET',404);
 await call(`bookings/${winner.booking.id}/cancel`,winner.other,{},'POST',404);await call(`bookings/${winner.booking.id}/payment-simulation`,winner.other,{result:'success'},'POST',404);
 await call(`bookings/${winner.booking.id}/cancel`,winner.token,{});await call(`bookings/${winner.booking.id}/cancel`,winner.token,{});assert.equal((await Departure.findById(d._id)).heldSeats,0);
 console.info('PASS last-seat race, idempotency, ownership, repeated cancellation');
 const p2=payload(d,await quote(a));const pending=(await call('bookings',a,p2)).data;const expires=pending.holdExpiresAt;
 await call(`bookings/${pending.id}/payment-simulation`,a,{result:'failure'});assert.equal((await call(`bookings/${pending.id}`,a)).data.holdExpiresAt,expires);
 await call(`bookings/${pending.id}/payment-simulation`,a,{result:'success'});await call(`bookings/${pending.id}/payment-simulation`,a,{result:'success'});let seats=await Departure.findById(d._id);assert.equal(seats.heldSeats,0);assert.equal(seats.bookedSeats,1);
 const ticket=(await call(`bookings/${pending.id}/ticket`,a)).data;assert(ticket.simulation);assert(!ticket.qrPayload.includes('@'));assert(!ticket.qrPayload.includes('0900000000'));
 assert.equal((await call(`tours/${tourId}/review-eligibility`,a)).data.eligible,false);
 await Booking.updateOne({_id:pending.id},{$set:{endsAt:new Date(Date.now()-1000)}});await completeDue();await completeDue();assert.equal((await Booking.findById(pending.id)).status,'COMPLETED');assert.equal((await call(`tours/${tourId}/review-eligibility`,a)).data.eligible,true);
 await call(`tours/${tourId}/reviews`,a,{stars:5,text:'A useful simulated review'});assert.equal((await Review.findOne({tourId})).source,'simulation');
 console.info('PASS payment failure/retry deadline, confirmation counters, ticket, completion and simulation review provenance');
 const d2=await Departure.create({tourId,date:addDate(date,1),timezone:tour.timezone,capacity:30,startsAt:zonedMidnight(addDate(date,1),tour.timezone),endsAt:zonedMidnight(addDate(date,3),tour.timezone)});
 const oldQuote=await quote(a,d2);await Tour.updateOne({_id:tourId},{$inc:{price:100}});assert.equal((await call('bookings',a,payload(d2,oldQuote),'POST',409)).code,'PRICE_CHANGED');assert.equal((await Departure.findById(d2._id)).heldSeats,0);
 const exp=(await call('bookings',a,payload(d2,await quote(a,d2)))).data;await Booking.updateOne({_id:exp.id},{$set:{holdExpiresAt:new Date(Date.now()-1000)}});assert.equal((await call(`bookings/${exp.id}/payment-simulation`,a,{result:'success'},'POST',409)).code,'HOLD_EXPIRED');await expireHolds(d2._id);await expireHolds(d2._id);assert.equal((await Departure.findById(d2._id)).heldSeats,0);
 const restart=(await call('bookings',a,payload(d2,await quote(a,d2)))).data;await Booking.updateOne({_id:restart.id},{$set:{holdExpiresAt:new Date(Date.now()-1000)}});startWorker();await stopWorker();startWorker();for(let i=0;i<30;i++){if((await Booking.findById(restart.id)).status==='EXPIRED')break;await new Promise(r=>setTimeout(r,250));}await stopWorker();assert.equal((await Booking.findById(restart.id)).status,'EXPIRED');assert.equal((await Departure.findById(d2._id)).heldSeats,0);
 const repeatedPayload=payload(d2,await quote(a,d2));const sameKey=await Promise.all([call('bookings',a,repeatedPayload),call('bookings',a,repeatedPayload)]);assert.equal(sameKey[0].data.id,sameKey[1].data.id);assert.equal((await Departure.findById(d2._id)).heldSeats,1);const cc=sameKey[0].data;await call(`bookings/${cc.id}/payment-simulation`,a,{result:'success'});await call(`bookings/${cc.id}/cancel`,a,{});await call(`bookings/${cc.id}/cancel`,a,{});assert.equal((await Departure.findById(d2._id)).heldSeats,0);assert.equal((await Departure.findById(d2._id)).bookedSeats,0);
 for(let i=0;i<11;i++)await call('bookings',a,payload(d2,await quote(a,d2)));
 const page1=(await call('users/me/bookings?filter=upcoming&page=1&limit=10',a)).data,page2=(await call('users/me/bookings?filter=upcoming&page=2&limit=10',a)).data;assert.equal(page1.items.length,10);assert(page1.hasMore);assert(page2.items.length>=1);assert(!page2.items.some(r=>page1.items.some(p=>p.id===r.id)));
 const notes=(await call('users/me/notifications',a)).data;assert(notes.unreadCount>0);const nid=notes.items[0].id;await call(`users/me/notifications/${nid}/read`,b,{},'PATCH',404);await call(`users/me/notifications/${nid}/read`,a,{},'PATCH');assert.equal((await Notification.findById(nid)).read,true);await call('users/me/notifications/read-all',a,{});assert.equal((await call('users/me/notifications',a)).data.unreadCount,0);
 console.info('PASS price change, repeated expiry, worker restart, paging/detail, persisted notification ownership/read-all');
 const prodCode=`const {app}=await import('./src/app.js');const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));const response=await fetch('http://127.0.0.1:'+s.address().port+'/api/bookings/000000000000000000000000/payment-simulation',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(response.status!==404)process.exitCode=1;await new Promise(r=>s.close(r));`;
 const production=spawnSync(process.execPath,['--input-type=module','-e',prodCode],{cwd:process.cwd(),env:{...process.env,NODE_ENV:'production',MAIL_MODE:'smtp',PUBLIC_BASE_URL:'https://example.invalid',ENABLE_PAYMENT_SIMULATION:'true'},encoding:'utf8',timeout:30000});assert.equal(production.status,0,'Production simulation route must be absent even with flag=true');
 console.info('PASS production route guard');
 const oldEnv=config.NODE_ENV;config.NODE_ENV='production';try {const {eligibilityFor,tourDto,getTour}=await import('../src/controllers/catalog.js');assert.equal((await eligibilityFor(users[0]._id,tourId)).eligible,false);assert.equal((await tourDto(await getTour(tourId))).ratingCount,0);}finally{config.NODE_ENV=oldEnv;}
 console.info('PASS production excludes simulation reviews/eligibility');
} catch(e) {console.error('Booking smoke failed:',e.name,e instanceof assert.AssertionError?e.message:(e.code||'runtime'));process.exitCode=1;}
finally {
 await stopWorker();if(server)await new Promise(resolve=>server.close(resolve));
 if(mongoose.connection.readyState===1){const ids=users.map(u=>u._id);await Notification.deleteMany({userId:{$in:ids}});await Session.deleteMany({userId:{$in:ids}});await Review.deleteMany({tourId});await Booking.deleteMany({tourId});await Departure.deleteMany({tourId});await Tour.deleteOne({_id:tourId});await User.deleteMany({_id:{$in:ids}});}await mongoose.disconnect();
}