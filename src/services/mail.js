import { config } from '../config.js';
import { fail } from '../middleware/http.js';
import { createSmtpMailer } from './smtp-mailer.js';
const mailer=createSmtpMailer(config);
export async function verifyMail() {
  if(config.MAIL_MODE!=='smtp')fail(503,'MAIL_UNAVAILABLE');
  try{await mailer.verify();}catch{fail(503,'MAIL_UNAVAILABLE');}
}
export async function sendOtp(email,purpose,otp) {
  if(config.MAIL_MODE==='console'&&config.NODE_ENV!=='production') {
    // Explicit development-only mode; never silently fall back after SMTP failure.
    console.info(`[DEV MAIL ${purpose}] ${email}: ${otp}`);return;
  }
  try{await mailer.sendOtp(email,purpose,otp);}catch{fail(503,'MAIL_UNAVAILABLE');}
}
