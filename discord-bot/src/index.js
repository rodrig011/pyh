import 'dotenv/config';
import { loadPhotoConfig, loadVipConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { createPhotoBot } from './bots/photoBot.js';
import { createVipBot } from './bots/vipBot.js';

const log = createLogger('main');

// Arranca los dos bots en un solo proceso. Son aplicaciones de Discord distintas,
// asi que cada una usa su propio token; si solo defines uno, solo arranca ese.
const started = [];

if (process.env.VIP_BOT_TOKEN) {
  const config = loadVipConfig();
  const { client, watcher } = createVipBot(config);
  started.push({ name: 'vip', client, stop: () => watcher.stop() });
  await client.login(config.token);
} else {
  log.warn('VIP_BOT_TOKEN no definido: el bot VIP no arranca');
}

if (process.env.PHOTO_BOT_TOKEN) {
  const config = loadPhotoConfig();
  const client = createPhotoBot(config);
  started.push({ name: 'fotos', client, stop: () => {} });
  await client.login(config.token);
} else {
  log.warn('PHOTO_BOT_TOKEN no definido: el bot de solo-fotos no arranca');
}

if (started.length === 0) {
  log.error('No hay ningun token configurado. Copia .env.example a .env y rellenalo.');
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
