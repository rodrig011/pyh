import 'dotenv/config';
import { loadPhotoConfig, loadVipConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { createPhotoBot } from './bots/photoBot.js';
import { createVipBot } from './bots/vipBot.js';

const log = createLogger('main');

/** Logs in with a readable error instead of a raw stack trace on a bad token. */
async function login(name, client, token) {
  try {
    await client.login(token);
  } catch (error) {
    const badToken = error.status === 401 || /invalid token/i.test(error.message ?? '');
    const detail =
      error.message && error.message !== 'No Description' ? error.message : `HTTP ${error.status ?? 'error'}`;
    log.error(
      `${name}: login failed — ${badToken ? 'that token is wrong or was regenerated in the developer portal' : detail}`,
    );
    process.exit(1);
  }
}

process.on('unhandledRejection', (error) => {
  log.error(`Unhandled error: ${error?.message ?? error}`);
});

// Starts both bots in a single process. They are separate Discord applications,
// so each one uses its own token; if only one token is set, only that one starts.
const started = [];

if (process.env.VIP_BOT_TOKEN) {
  const config = loadVipConfig();
  const { client, watcher } = createVipBot(config);
  started.push({ name: 'vip', client, stop: () => watcher.stop() });
  await login('VIP bot', client, config.token);
} else {
  log.warn('VIP_BOT_TOKEN is not set: the VIP bot will not start');
}

if (process.env.PHOTO_BOT_TOKEN) {
  const config = loadPhotoConfig();
  const client = createPhotoBot(config);
  started.push({ name: 'photos bot', client, stop: () => {} });
  await login('photos bot', client, config.token);
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
