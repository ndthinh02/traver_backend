import { z } from 'zod';
import { Booking, Departure, Notification, Tour } from '../models/index.js';
import { parse, objectId, email, ok, fail } from '../middleware/http.js';
import * as service from '../services/bookings.js';
const participants = z.object({ departureId: objectId, adults: z.number().int().min(1).max(20), children: z.number().int().min(0).max(19) }).strict().refine(v=>v.adults+v.children<=20);
const pages = z.object({ page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(50).default(10) });
export async function departures(req,res) {
 const tour=await Tour.findOne({_id:req.params.id,published:true});if(!tour)fail(404,'TOUR_NOT_FOUND');await service.expireHolds(undefined,{tourId:tour._id});
 const v=parse(pages.strict(),req.query),match={tourId:tour._id,status:'open',startsAt:{$gt:new Date()}};
 const [rows,total]=await Promise.all([Departure.find(match).sort({date:1,_id:1}).skip((v.page-1)*v.limit).limit(v.limit),Departure.countDocuments(match)]);
 ok(res,{items:rows.map(d=>({id:String(d._id),tourId:d.tourId,date:d.date,timezone:d.timezone,capacity:d.capacity,remaining:Math.max(0,d.capacity-d.heldSeats-d.bookedSeats),startsAt:d.startsAt,endsAt:d.endsAt})),...v,total,hasMore:v.page*v.limit<total,timezone:tour.timezone,serverTime:new Date()});
}
export async function quote(req,res) {let v;try{v=parse(participants,req.body);}catch(e){if(e instanceof z.ZodError)fail(400,'INVALID_PARTICIPANTS');throw e;}ok(res,await service.quote(req.user._id,v));}
export async function create(req,res) {
 const v=parse(z.object({departureId:objectId,adults:z.number().int().min(1).max(20),children:z.number().int().min(0).max(19),contact:z.object({name:z.string().trim().min(1).max(100),email,phone:z.string().trim().regex(/^[+\d ()-]{8,30}$/).refine(v=>v.replace(/\D/g,'').length>=8)}).strict(),method:z.enum(['Card','Transfer']),quoteToken:z.string().min(1).max(4096),idempotencyKey:z.uuid()}).strict(),req.body);
 ok(res,await service.createBooking(req.user._id,v));
}
export async function detail(req,res) {parse(objectId,req.params.id);ok(res,await service.detail(req.params.id,req.user._id));}
export async function list(req,res) {
 const v=parse(pages.extend({filter:z.enum(['upcoming','completed','cancelled','expired','all']).default('upcoming'),q:z.string().trim().max(100).default('')}).strict(),req.query);
 await service.expireHolds(undefined,{userId:req.user._id});await service.completeDue();
 const match={userId:req.user._id,source:{$ne:'development-fixture'}};
 if(v.filter!=='all')match.status=v.filter==='upcoming'?{$in:['PENDING_PAYMENT','CONFIRMED']}:v.filter.toUpperCase();
 if(v.q){const regex=new RegExp(v.q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');match.$or=[{'snapshot.name':regex},{code:regex}];}
 const [rows,total]=await Promise.all([Booking.find(match).sort({createdAt:-1,_id:1}).skip((v.page-1)*v.limit).limit(v.limit),Booking.countDocuments(match)]);
 ok(res,{items:rows.map(service.bookingDto),page:v.page,limit:v.limit,total,hasMore:v.page*v.limit<total,serverTime:new Date()});
}
export async function cancel(req,res) {parse(objectId,req.params.id);const v=parse(z.object({reason:z.string().trim().max(300).optional()}).strict(),req.body);ok(res,await service.cancel(req.params.id,req.user._id,v.reason));}
export async function payment(req,res) {parse(objectId,req.params.id);const v=parse(z.object({result:z.enum(['success','failure','cancel'])}).strict(),req.body);ok(res,await service.payment(req.params.id,req.user._id,v.result));}
export async function ticket(req,res) {
 parse(objectId,req.params.id);const b=await service.detail(req.params.id,req.user._id);if(!b.snapshot || !['CONFIRMED','COMPLETED'].includes(b.status))fail(409,'INVALID_BOOKING_STATE');
 ok(res,{booking:b,qrPayload:`TRAVER-TEST:${b.id}:${b.code}`,simulation:true,label:'Test ticket — not valid for travel. Check current booking status on server.'});
}
export async function notifications(req,res) {
 const v=parse(pages.strict(),req.query),match={userId:req.user._id};
 const [items,total,unreadCount]=await Promise.all([Notification.find(match).sort({createdAt:-1,_id:1}).skip((v.page-1)*v.limit).limit(v.limit).lean(),Notification.countDocuments(match),Notification.countDocuments({...match,read:false})]);
 ok(res,{items:items.map(({_id,__v,...n})=>({id:String(_id),...n,userId:String(n.userId),bookingId:String(n.bookingId)})),...v,total,hasMore:v.page*v.limit<total,unreadCount});
}
export async function read(req,res) {parse(objectId,req.params.id);const n=await Notification.findOneAndUpdate({_id:req.params.id,userId:req.user._id},{$set:{read:true}},{new:true});if(!n)fail(404,'NOT_FOUND');ok(res);}
export async function readAll(req,res) {await Notification.updateMany({userId:req.user._id,read:false},{$set:{read:true}});ok(res);}