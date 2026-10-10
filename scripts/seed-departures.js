import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Tour, Departure } from '../src/models/index.js';
import { addDate, zonedMidnight } from '../src/services/bookings.js';
const args=process.argv.slice(2);
const options=Object.fromEntries(args.map(arg=>{const match=/^--(days|tour)=(.+)$/.exec(arg);if(!match)throw new Error('Usage: npm run seed:departures -- [--days=30] [--tour=tour-id]');return [match[1],match[2]];}));
const days=Number(options.days||30);
if(config.NODE_ENV!=='development')throw new Error('Reference departures can only be seeded in development');
if(!Number.isInteger(days)||days<1||days>90)throw new Error('days must be 1..90');
try {
 const deadline=setTimeout(()=>{console.error('Departure seed connection timed out; no departures written.');process.exit(1);},45000);
 try{await mongoose.connect(config.MONGODB_URI,{serverSelectionTimeoutMS:10000,connectTimeoutMS:10000});}finally{clearTimeout(deadline);}
 await Departure.init();
 const tours=await Tour.find({published:true,...(options.tour?{_id:options.tour}:{})}).lean();
 if(!tours.length)throw new Error('No matching published tour');
 // Validate the entire selection before adding anything. Never infer a capacity or timezone.
 const plans=tours.map(t=>{
  if(!Number.isInteger(t.capacity)||t.capacity<1||t.capacity>10000||!Number.isInteger(t.days)||t.days<1||t.days>365||!t.timezone)throw new Error('Tour is missing valid capacity, duration or timezone');
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:t.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const p=k=>parts.find(x=>x.type===k).value;const today=`${p('year')}-${p('month')}-${p('day')}`;
  return Array.from({length:days},(_,i)=>{const date=addDate(today,i+1);return {updateOne:{filter:{tourId:t._id,date},update:{$setOnInsert:{tourId:t._id,date,timezone:t.timezone,capacity:t.capacity,heldSeats:0,bookedSeats:0,status:'open',startsAt:zonedMidnight(date,t.timezone),endsAt:zonedMidnight(addDate(date,t.days),t.timezone)}},upsert:true}};});
 });
 let inserted=0;
 for(const plan of plans){const result=await Departure.bulkWrite(plan,{ordered:true});inserted+=result.upsertedCount;}
 console.info(`Departures: ${tours.length} tours, ${days} future days per tour; ${inserted} inserted. Existing departures, closed dates and reserved seats preserved.`);
}catch(e){console.error(`Departure seed failed: ${e.name}. Check database connectivity and published tour capacity/days/timezone. No credentials logged.`);process.exitCode=1;}finally{await mongoose.disconnect();}
