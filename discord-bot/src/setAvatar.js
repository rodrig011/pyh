import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REST, Routes } from 'discord.js';
import { loadPhotoConfig, loadVipConfig } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('avatar');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };

function dataUri(path) {
  const file = resolve(path);
  const extension = file.split('.').pop().toLowerCase();
  const mime = MIME[extension];
  if (!mime) throw new Error(`Unsupported image type: .${extension} (use png, jpg or gif)`);
  const bytes = readFileSync(file);
  if (bytes.length > 10 * 1024 * 1024) throw new Error(`${path} is larger than Discord's 10 MB limit`);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** Sets the avatar (and optionally the username) of the bot behind a token. */
export async function applyProfile({ token, avatarPath, username }) {
  const body = { avatar: dataUri(avatarPath) };
  if (username) body.username = username;

  const rest = new REST({ version: '10' }).setToken(token);
  const user = await rest.patch(Routes.user('@me'), { body });
  return user;
}

const targets = [];
if (process.env.VIP_BOT_TOKEN) {
  const config = loadVipConfig();
  targets.push({ name: 'VIP bot', token: config.token, avatarPath: config.avatarPath, username: config.username });
}
if (process.env.PHOTO_BOT_TOKEN) {
  const config = loadPhotoConfig();
  targets.push({ name: 'photos bot', token: config.token, avatarPath: config.avatarPath, username: config.username });
}

if (targets.length === 0) {
  log.error('No bot token found. Fill in VIP_BOT_TOKEN and/or PHOTO_BOT_TOKEN in .env first.');
  process.exit(1);
}

function describe(error) {
  const status = error.status ?? error.httpStatus;
  const detail = error.message && error.message !== 'No Description' ? error.message : error.rawError?.message;
  const parts = [status ? `HTTP ${status}` : null, detail || 'unknown error'].filter(Boolean);
  // Discord only allows a couple of avatar changes per hour per bot.
  if (status === 429) parts.push('avatar changes are rate limited, try again in an hour');
  if (status === 401) parts.push('the bot token is wrong or was regenerated');
  return parts.join(' — ');
}

let failures = 0;
for (const target of targets) {
  try {
    const user = await applyProfile(target);
    log.info(`${target.name}: avatar updated from ${target.avatarPath} (now ${user.username})`);
  } catch (error) {
    failures += 1;
    log.error(`${target.name}: ${describe(error)}`);
  }
}

process.exit(failures === targets.length ? 1 : 0);
