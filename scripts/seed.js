import mongoose from 'mongoose';
import { zonedMidnight, addDate } from '../src/services/bookings.js';
import { config } from '../src/config.js';
import { Tour, Departure } from '../src/models/index.js';
import { catalog } from '../src/data/catalog.js';
import { importPhotos, writeCredits } from './catalog-media.js';
const refresh=process.argv.includes('--refresh-catalog'),photos=process.argv.includes('--photos'),used=new Set();
let created=0,updated=0,photoTours=0;
try {
 await mongoose.connect(config.MONGODB_URI,{serverSelectionTimeoutMS:10000});await Tour.init();await Departure.init();
 for(const entry of catalog){
  const {wiki,...tour}=entry;const old=await Tour.findById(tour._id).lean();
  // Only refresh known reference catalog documents, never an independently edited supplier catalog.
  const managed=!old||/^Legacy sample catalog:|^Reference catalog v2;/.test(old.assetNote||'');
  if(!managed)continue;
  const shouldUpdate=!old||refresh;
  if(photos && shouldUpdate){try{const media=await importPhotos(entry,used);tour.image=`${config.PUBLIC_BASE_URL.replace(/\/$/,'')}/uploads/catalog/${media.photos[0].file}`;tour.gallery=media.photos.map(p=>`${config.PUBLIC_BASE_URL.replace(/\/$/,'')}/uploads/catalog/${p.file}`);tour.assetNote=`Reference catalog v2; licensed Wikimedia destination photos; attribution: /uploads/catalog/credits.html#${tour._id}; approximate area coordinates, not a meeting point.`;photoTours++;}catch(e){console.info(`Location photos unavailable for ${tour._id}; keeping current photos or category illustration`);if(old && /^https?:/.test(old.image)){tour.image=old.image;tour.gallery=old.gallery;tour.assetNote=old.assetNote;}}}
  if(old && !photos && /^https?:/.test(old.image)){tour.image=old.image;tour.gallery=old.gallery;tour.assetNote=old.assetNote;}
  if(old && shouldUpdate){const fields=['name','slug','category','location','lat','lon','image','gallery','assetNote','description','descriptionVi','itinerary','itineraryVi','featured','popular'];await Tour.updateOne({_id:tour._id},{$set:Object.fromEntries(fields.map(k=>[k,tour[k]]))});updated++;}
  else if(!old){await Tour.updateOne({_id:tour._id},{$setOnInsert:tour},{upsert:true});created++;}
  const effective=old||tour;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:effective.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const part=k=>parts.find(p=>p.type===k).value;const start=`${part('year')}-${part('month')}-${part('day')}`;
  for(let d=1;d<=30;d++){const date=addDate(start,d);await Departure.updateOne({tourId:tour._id,date},{$setOnInsert:{tourId:tour._id,date,capacity:effective.capacity,timezone:effective.timezone,startsAt:zonedMidnight(date,effective.timezone),endsAt:zonedMidnight(addDate(date,effective.days),effective.timezone),heldSeats:0,bookedSeats:0,status:'open'}},{upsert:true});}
 }
 if(photos)await writeCredits();console.info(`Catalog: ${catalog.length} reference tours; ${created} inserted, ${updated} refreshed, ${photoTours} with location photos. Existing prices, bookings and reserved seats preserved.`);
}catch(e){console.error(`Catalog update failed: ${e.name}. Check database connectivity/configuration; no credentials logged.`);process.exitCode=1;}finally{await mongoose.disconnect();}
