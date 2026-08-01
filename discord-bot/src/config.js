import 'dotenv/config';

function str(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

function required(name) {
  const value = str(name);
  if (value === undefined) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function bool(name, fallback) {
  const value = str(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(name, fallback) {
  const value = str(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

/** Turns "50" or "50.00" into cents (5000). */
function money(name, fallback) {
  const value = str(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value.replace(',', '.'));
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a valid amount`);
  return Math.round(parsed * 100);
}

function list(name, fallback = []) {
  const value = str(name);
  if (value === undefined) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Comma-separated numbers, biggest first: "3,1" -> [3, 1]. */
function numberList(name, fallback) {
  const values = list(name);
  if (values.length === 0) return fallback;
  const parsed = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  if (parsed.length === 0) throw new Error(`${name} must be a comma-separated list of numbers`);
  return parsed.sort((a, b) => b - a);
}

export function loadVipConfig() {
  return {
    token: required('VIP_BOT_TOKEN'),
    clientId: required('VIP_CLIENT_ID'),
    guildId: required('VIP_GUILD_ID'),
    // Profile picture applied by `npm run avatar`.
    avatarPath: str('VIP_BOT_AVATAR', 'assets/avatar-512.png'),
    username: str('VIP_BOT_USERNAME'),
    deployCommandsOnStart: bool('DEPLOY_COMMANDS_ON_START', true),
    logChannelId: str('VIP_LOG_CHANNEL_ID'),
    // Roles allowed to run /vip-admin. Once this is set, ONLY these roles (plus
    // anyone with Administrator) can touch orders, payments and memberships.
    modRoleIds: list('VIP_MOD_ROLE_IDS', list('VIP_ADMIN_ROLE_IDS')),
    // How long a paid membership lasts, and when to warn before it runs out.
    subscriptionDays: int('SUBSCRIPTION_DAYS', 30),
    reminderDaysBefore: numberList('SUBSCRIPTION_REMINDER_DAYS', [3, 1]),
    subscriptionGraceDays: int('SUBSCRIPTION_GRACE_DAYS', 0),
    sweepIntervalMinutes: int('SWEEP_INTERVAL_MINUTES', 15),
    zelleRecipient: str('ZELLE_RECIPIENT', '(set ZELLE_RECIPIENT)'),
    zelleRecipientName: str('ZELLE_RECIPIENT_NAME'),
    orderTtlHours: int('ORDER_TTL_HOURS', 48),
    // How much the payment may fall short (in cents) and still count. 0 = exact amount.
    amountToleranceCents: money('AMOUNT_TOLERANCE', 0),
    // If someone overpays, grant the highest tier the amount covers.
    upgradeOnOverpay: bool('UPGRADE_ON_OVERPAY', true),
    codePrefix: str('CODE_PREFIX', 'VIP'),
    codeLength: int('CODE_LENGTH', 6),
    storePath: str('STORE_PATH', 'data/store.json'),
    tiers: {
      1: { tier: 1, priceCents: money('TIER_1_PRICE', 5000), roleId: str('ROLE_TIER_1') },
      2: { tier: 2, priceCents: money('TIER_2_PRICE', 10000), roleId: str('ROLE_TIER_2') },
      3: { tier: 3, priceCents: money('TIER_3_PRICE', 20000), roleId: str('ROLE_TIER_3') },
    },
    imap: {
      enabled: bool('IMAP_ENABLED', true),
      host: str('IMAP_HOST'),
      port: int('IMAP_PORT', 993),
      secure: bool('IMAP_SECURE', true),
      user: str('IMAP_USER'),
      password: str('IMAP_PASSWORD'),
      mailbox: str('IMAP_MAILBOX', 'INBOX'),
      pollSeconds: int('IMAP_POLL_SECONDS', 60),
      sinceDays: int('IMAP_SINCE_DAYS', 3),
      markSeen: bool('IMAP_MARK_SEEN', true),
      // Only emails coming from these senders are trusted.
      allowedSenders: list('IMAP_ALLOWED_SENDERS'),
    },
  };
}

export function loadPhotoConfig() {
  return {
    token: required('PHOTO_BOT_TOKEN'),
    avatarPath: str('PHOTO_BOT_AVATAR', 'assets/avatar-512.png'),
    username: str('PHOTO_BOT_USERNAME'),
    channelIds: list('PHOTO_ONLY_CHANNEL_IDS'),
    allowCaptions: bool('PHOTO_ONLY_ALLOW_CAPTIONS', false),
    allowVideos: bool('PHOTO_ONLY_ALLOW_VIDEOS', false),
    allowLinks: bool('PHOTO_ONLY_ALLOW_LINKS', false),
    ignoreBots: bool('PHOTO_ONLY_IGNORE_BOTS', true),
    bypassRoleIds: list('PHOTO_ONLY_BYPASS_ROLE_IDS'),
    warn: bool('PHOTO_ONLY_WARN', true),
    warnSeconds: int('PHOTO_ONLY_WARN_SECONDS', 8),
    logChannelId: str('PHOTO_ONLY_LOG_CHANNEL_ID'),
  };
}

export const helpers = { str, bool, int, money, list };
