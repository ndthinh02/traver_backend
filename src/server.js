import mongoose from 'mongoose';
import { config } from './config.js';
import { app } from './app.js';
import * as models from './models/index.js';
import { initializeBookings, startWorker, stopWorker } from './services/bookings.js';
let server; let closing=false;
try {
  await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 20000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB replica set is required for auth transactions');
  await initializeBookings();
  await Promise.all(Object.values(models).map(m => m.init()));
  await new Promise((resolve, reject) => { server = app.listen(config.PORT, '0.0.0.0', resolve); server.once('error', reject); });
  startWorker();
  console.info(`Traver API listening on port ${config.PORT}`);
} catch (e) { console.error(`Startup failed: ${e.name}. Check MongoDB/configuration.`); await mongoose.disconnect(); process.exitCode = 1; }
async function shutdown() { if(closing)return;closing=true;const worker=stopWorker(); if (server) { const closed = new Promise(resolve => server.close(resolve)); server.closeIdleConnections(); const timer = setTimeout(() => server.closeAllConnections(), 10000); await closed; clearTimeout(timer); } await worker; await mongoose.disconnect(); }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
