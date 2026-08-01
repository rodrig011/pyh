import 'dotenv/config';
import { loadPhotoConfig, loadVipConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { createPhotoBot } from './bots/photoBot.js';
import { createVipBot } from './bots/vipBot.js';

const log = createLogger('main');

// Starts both bots in a single process. They are separate Discord applications,
// so each one uses its own token; if only one token is set, only that one starts.
const started = [];

if (process.env.VIP_BOT_TOKEN) {
  const config = loadVipConfig();
  const { client, watcher } = createVipBot(config);
  started.push({ name: 'vip', client, stop: () => watcher.stop() });
  await client.login(config.token);
} else {
  log.warn('VIP_BOT_TOKEN is not set: the VIP bot will not start');
}

if (process.env.PHOTO_BOT_TOKEN) {
  const config = loadPhotoConfig();
  const client = createPhotoBot(config);
  started.push({ name: 'photos', client, stop: () => {} });
  await client.login(config.token);
} else {
  log.warn('PHOTO_BOT_TOKEN is not set: the photos-only bot will not start');
}

if (started.length === 0) {
  log.error('No token configured. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const shutdown = () => {
  for (const bot of started) {
    bot.stop();
    bot.client.destroy();
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
