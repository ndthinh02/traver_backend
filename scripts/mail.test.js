import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createSmtpMailer, otpMessage } from '../src/services/smtp-mailer.js';
const config={SMTP_HOST:'smtp.example.org',SMTP_PORT:587,SMTP_USER:'sender@example.org',SMTP_PASS:'test-only-password',SMTP_FROM:'Traver <sender@example.org>'};
function harness(override={},behavior={}){
 let options,closed=0,message;const warnings=[];
 const mailer=createSmtpMailer({...config,...override},{warn:r=>warnings.push(r),timeoutMs:50,createTransport:o=>{options=o;return {
  sendMail:async m=>{message=m;if(behavior.error)throw behavior.error;return behavior.result||{accepted:['receiver@example.org'],rejected:[]};},
  verify:async()=>behavior.hang?new Promise(()=>{}):true,
  close:()=>closed++
 };}});
 return {mailer,warnings,get options(){return options;},get closed(){return closed;},get message(){return message;}};
}
test('Registration and reset messages have distinct subjects, HTML/text and expiry guidance',async()=>{
 const register=otpMessage('register','0123'),reset=otpMessage('reset','9876');
 assert.notEqual(register.subject,reset.subject);assert.match(register.text,/0123/);assert.match(register.html,/0123/);assert.match(reset.text,/9876/);assert.match(register.text,/5 phút/);
 assert.throws(()=>otpMessage('register','bad'),TypeError);
 const stream=nodemailer.createTransport({streamTransport:true,buffer:true});
 const result=await stream.sendMail({from:config.SMTP_FROM,to:'receiver@example.org',...register});
 const mime=result.message.toString();assert.match(mime,/multipart\/alternative/);assert.match(mime,/0123/);stream.close();
});
test('587 requires STARTTLS, 465 uses TLS; message accepted and transport closed',async()=>{
 const h=harness();await h.mailer.sendOtp('receiver@example.org','register','0123');assert.equal(h.options.secure,false);assert.equal(h.options.requireTLS,true);assert.equal(h.options.tls.minVersion,'TLSv1.2');assert.equal(h.closed,1);assert.equal(h.message.to,'receiver@example.org');assert.equal(h.warnings.length,0);
 const tls=harness({SMTP_PORT:465});await tls.mailer.verify();assert.equal(tls.options.secure,true);assert.equal(tls.closed,1);
});
test('Recipient rejection is a failure even when sendMail resolves',async()=>{
 const h=harness({}, {result:{accepted:[],rejected:['receiver@example.org']}});
 await assert.rejects(h.mailer.sendOtp('receiver@example.org','reset','0123'),/MAIL_UNAVAILABLE/);assert.deepEqual(h.warnings,['SMTP_RECIPIENT_REJECTED']);assert.equal(h.closed,1);
});
test('Missing configuration and authentication failures expose only safe reasons',async()=>{
 const missing=harness({SMTP_PASS:''});await assert.rejects(missing.mailer.verify(),/MAIL_UNAVAILABLE/);assert.deepEqual(missing.warnings,['SMTP_NOT_CONFIGURED']);
 const auth=harness({}, {error:Object.assign(new Error('private server reply'),{code:'EAUTH'})});await assert.rejects(auth.mailer.sendOtp('receiver@example.org','register','0123'),/MAIL_UNAVAILABLE/);assert.deepEqual(auth.warnings,['EAUTH']);assert.equal(auth.closed,1);
});
test('Absolute timeout closes a stuck transport',async()=>{
 const h=harness({}, {hang:true});await assert.rejects(h.mailer.verify(),/MAIL_UNAVAILABLE/);assert.deepEqual(h.warnings,['SMTP_TIMEOUT']);assert.equal(h.closed,1);
});
test('Gmail App Password spacing is normalized without altering other provider passwords',async()=>{
 const gmail=harness({SMTP_HOST:'smtp.gmail.com',SMTP_PASS:'abcd efgh ijkl mnop'});await gmail.mailer.verify();assert.equal(gmail.options.auth.pass,'abcdefghijklmnop');
 const other=harness({SMTP_PASS:'with spaces'});await other.mailer.verify();assert.equal(other.options.auth.pass,'with spaces');
});
