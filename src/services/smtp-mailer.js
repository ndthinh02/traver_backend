import nodemailer from 'nodemailer';
export class MailDeliveryError extends Error {
  constructor(reason) { super('MAIL_UNAVAILABLE'); this.name='MailDeliveryError';this.reason=reason; }
}
export function otpMessage(purpose, otp) {
  if(!['register','reset'].includes(purpose)||!/^\d{4}$/.test(otp))throw new TypeError('Invalid OTP message');
  const action=purpose==='register'?'xác minh tài khoản':'đặt lại mật khẩu';
  return {
    subject:purpose==='register'?'Traver — Mã xác minh tài khoản':'Traver — Mã đặt lại mật khẩu',
    text:`Mã ${action} Traver của bạn là: ${otp}.\nMã có hiệu lực trong 5 phút kể từ khi yêu cầu.\nKhông chia sẻ mã này với bất kỳ ai. Nếu bạn không yêu cầu, hãy bỏ qua email này.`,
    html:`<!doctype html><html lang="vi"><meta charset="utf-8"><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px"><div style="max-width:480px;margin:auto;background:white;border-radius:16px;padding:32px"><h1 style="font-size:26px">traver</h1><h2 style="font-size:20px">Mã ${action}</h2><p>Dùng mã dưới đây để ${action} trong ứng dụng Traver.</p><p style="font-size:36px;font-weight:bold;letter-spacing:8px">${otp}</p><p>Mã có hiệu lực trong <strong>5 phút kể từ khi yêu cầu</strong>.</p><p>Không chia sẻ mã này với bất kỳ ai. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p></div></body></html>`
  };
}
const safeReasons=new Set(['EAUTH','ECONNECTION','ETIMEDOUT','ESOCKET','EDNS','EENVELOPE','EMESSAGE','ETLS']);
export function createSmtpMailer(settings, {createTransport=options=>nodemailer.createTransport(options),warn=reason=>console.warn(`Email delivery unavailable: ${reason}`),timeoutMs=15000}={}) {
  function transport() {
    if(!settings.SMTP_HOST?.trim()||!settings.SMTP_USER?.trim()||!settings.SMTP_PASS||!settings.SMTP_FROM?.trim())throw new MailDeliveryError('SMTP_NOT_CONFIGURED');
    if(!Number.isInteger(settings.SMTP_PORT)||settings.SMTP_PORT<1||settings.SMTP_PORT>65535)throw new MailDeliveryError('SMTP_INVALID_PORT');
    return createTransport({
      host:settings.SMTP_HOST.trim(),port:settings.SMTP_PORT,secure:settings.SMTP_PORT===465,requireTLS:settings.SMTP_PORT!==465,
      auth:{user:settings.SMTP_USER.trim(),pass:settings.SMTP_HOST.trim().toLowerCase()==='smtp.gmail.com'?settings.SMTP_PASS.replace(/\s/g,''):settings.SMTP_PASS},
      tls:{minVersion:'TLSv1.2'},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,dnsTimeout:5000,
      logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true
    });
  }
  async function run(action) {
    let client, timer;
    try {
      client=transport();
      return await Promise.race([action(client),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new MailDeliveryError('SMTP_TIMEOUT')),timeoutMs);
      })]);
    }
    catch(e){const reason=e instanceof MailDeliveryError?e.reason:safeReasons.has(e.code)?e.code:'SMTP_ERROR';warn(reason);throw new MailDeliveryError(reason);}
    finally{clearTimeout(timer);client?.close();}
  }
  return {
    verify:()=>run(client=>client.verify()),
    sendOtp:(email,purpose,otp)=>{
      const message=otpMessage(purpose,otp);
      return run(async client=>{
        const result=await client.sendMail({from:settings.SMTP_FROM.trim(),to:email,...message});
        if(!result.accepted?.some(address=>String(address).toLowerCase()===email.toLowerCase())||result.rejected?.length)throw new MailDeliveryError('SMTP_RECIPIENT_REJECTED');
        // SMTP acceptance does not prove inbox delivery; spam filtering is outside this service.
      });
    }
  };
}
