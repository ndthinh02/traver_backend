// Checks SMTP DNS/TLS/login only. It does not send mail or display credentials.
try {
  const { verifyMail }=await import('../src/services/mail.js');
  await verifyMail();
  console.info('SMTP connection, TLS and authentication verified. Register in the app to check actual OTP delivery; inspect Spam if needed.');
}catch{console.error('SMTP check failed. Set MAIL_MODE=smtp and check SMTP_HOST/PORT/USER/PASS/FROM in backend/.env. No credentials logged.');process.exitCode=1;}
