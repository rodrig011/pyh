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

/**
 * A block of copy written on one line. Both "|" and a literal \n split it into
 * bullet lines, so perks can be edited from a hosting dashboard that has no
 * multi-line inputs.
 */
function lines(name, fallback) {
  const value = str(name);
  if (value === undefined) return fallback;
  return value
    .split(/\||\\n|\n/)
    .map((line) => line.trim())
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

// The team the take is split between, evenly, on every real payment. Only a
// fallback — set TEAM_MEMBER_IDS in Railway to change the roster without a
// code edit, but a bot that cannot start without it would block launch over
// a spreadsheet problem, not a code one.
const DEFAULT_TEAM = [
  { id: '751558809817841745', name: 'Rodrig0.11' },
  { id: '1151805597705044059', name: 'lamdiv' },
  { id: '1529651350713925723', name: 'Potleaf420' },
  { id: '1339768036923805728', name: 'danielreseel' },
  { id: '702712770835251261', name: 'cvvnumber' },
];

export function loadVipConfig() {
  const guildId = required('VIP_GUILD_ID');
  return {
    token: required('VIP_BOT_TOKEN'),
    clientId: required('VIP_CLIENT_ID'),
    guildId,
    // The name shown on the storefront and the welcome DM. Set once in Railway
    // rather than hardcoded, because it changed once already.
    brandName: str('VIP_BRAND_NAME', 'The Playbook BTC 15 min'),
    // Profile picture applied by `npm run avatar`.
    avatarPath: str('VIP_BOT_AVATAR', 'assets/avatar-512.png'),
    username: str('VIP_BOT_USERNAME'),
    deployCommandsOnStart: bool('DEPLOY_COMMANDS_ON_START', true),
    logChannelId: str('VIP_LOG_CHANNEL_ID'),
    // Roles allowed to run /vip-admin. Once this is set, ONLY these roles (plus
    // anyone with Administrator) can touch orders, payments and memberships.
    modRoleIds: list('VIP_MOD_ROLE_IDS', list('VIP_ADMIN_ROLE_IDS')),
    // Specific people who are banned on sight, by Discord user id — not name,
    // which a banned person can change before ever rejoining.
    banUserIds: list('BAN_USER_IDS'),
    // Who the take is split between. See DEFAULT_TEAM above for the fallback.
    team: str('TEAM_MEMBER_IDS')
      ? list('TEAM_MEMBER_IDS').map((id) => ({ id, name: null }))
      : DEFAULT_TEAM,
    // Mention the mod roles in the log channel whenever money moves.
    pingModsOnPayment: bool('PING_MODS_ON_PAYMENT', true),
    // Payments carrying no VIP code are assumed to be the owner's personal
    // transfers and are never posted to Discord. Turn on to see them anyway.
    logUnmatchedPayments: bool('LOG_UNMATCHED_PAYMENTS', false),
    // Category the private ticket channels are created under (optional).
    ticketCategoryId: str('TICKET_CATEGORY_ID'),
    // DM every new arrival with the storefront so nobody has to find a command.
    welcomeDm: bool('WELCOME_DM', true),
    // Handed to anyone who buys before they have joined, and the link to put on
    // a poster. Discord refuses a DM between strangers, so the invite is what
    // turns "DM the bot" into something a stranger can actually do.
    serverInviteUrl: str('SERVER_INVITE_URL'),
    // Answer anyone who writes to the bot in a DM with the storefront and the
    // invite. Somebody who messages a sales bot is asking how to buy, and the
    // cooldown keeps a three-message stranger from getting three storefronts.
    dmAutoReply: bool('DM_AUTO_REPLY', true),
    dmReplyCooldownHours: int('DM_REPLY_COOLDOWN_HOURS', 24),
    // How long a paid membership lasts, and when to warn before it runs out.
    subscriptionDays: int('SUBSCRIPTION_DAYS', 30),
    reminderDaysBefore: numberList('SUBSCRIPTION_REMINDER_DAYS', [3, 1]),
    subscriptionGraceDays: int('SUBSCRIPTION_GRACE_DAYS', 0),
    sweepIntervalMinutes: int('SWEEP_INTERVAL_MINUTES', 15),
    zelleRecipient: str('ZELLE_RECIPIENT', '(set ZELLE_RECIPIENT)'),
    zelleRecipientName: str('ZELLE_RECIPIENT_NAME'),
    // Venmo works exactly like Zelle: a one-off payment identified by the code
    // in the note. Leave the handle empty and it is simply not offered.
    venmoRecipient: str('VENMO_RECIPIENT'),
    venmoRecipientName: str('VENMO_RECIPIENT_NAME'),
    // Cash App sends no email the bot can read, so a mod confirms these by
    // hand. Offered anyway: a payment method somebody already has beats a
    // better one they have to sign up for.
    cashAppRecipient: str('CASHAPP_RECIPIENT'),
    cashAppRecipientName: str('CASHAPP_RECIPIENT_NAME'),
    orderTtlHours: int('ORDER_TTL_HOURS', 48),
    // How much the payment may fall short (in cents) and still count. 0 = exact amount.
    amountToleranceCents: money('AMOUNT_TOLERANCE', 0),
    // Most bank alerts never repeat the memo, so the code the buyer typed does
    // not reach the bot. When a single fresh order is waiting for that exact
    // amount, that order is the payment. Anything less certain is not guessed.
    matchByAmount: bool('MATCH_BY_AMOUNT', true),
    amountMatchWindowMinutes: int('AMOUNT_MATCH_WINDOW_MINUTES', 180),
    // If someone overpays, grant the highest tier the amount covers.
    upgradeOnOverpay: bool('UPGRADE_ON_OVERPAY', true),
    codePrefix: str('CODE_PREFIX', 'VIP'),
    codeLength: int('CODE_LENGTH', 6),
    storePath: str('STORE_PATH', 'data/store.json'),
    tiers: {
      1: {
        tier: 1,
        priceCents: money('TIER_1_PRICE', 5000),
        roleId: str('ROLE_TIER_1'),
        label: str('TIER_1_LABEL', 'Signals'),
        perks: lines('TIER_1_PERKS', [
          '📈 **Every signal, as it drops** — the plays are posted the moment they are live.',
          '🔔 Entries, exits and the reasoning behind each one.',
        ]),
      },
      2: {
        tier: 2,
        priceCents: money('TIER_2_PRICE', 10000),
        roleId: str('ROLE_TIER_2'),
        label: str('TIER_2_LABEL', 'VIP'),
        perks: lines('TIER_2_PERKS', [
          '✅ Everything in Signals, plus:',
          '💬 **The VIP room** — talk with the whole crew and with the elites.',
          '🤝 Ask questions and compare plays in real time, not after the fact.',
        ]),
      },
      3: {
        tier: 3,
        priceCents: money('TIER_3_PRICE', 20000),
        roleId: str('ROLE_TIER_3'),
        label: str('TIER_3_LABEL', 'Elite'),
        perks: lines('TIER_3_PERKS', [
          '✅ Everything in VIP, plus:',
          '🎓 **Private lessons** — learn how the plays are built, not just what they are.',
          '📞 **Calls with the elites** and one-on-one help.',
          '🎯 Personal guidance on your own bankroll and your own plays.',
        ]),
      },
    },
    // The signal engine's raw material. Sampling is cheap and the history is
    // the only thing that cannot be bought later, so it runs by default.
    signals: {
      collect: bool('SIGNALS_COLLECT', true),
      sampleSeconds: int('SIGNALS_SAMPLE_SECONDS', 30),
      flushEvery: int('SIGNALS_FLUSH_EVERY', 10),
    },
    // Trading calls: who may post them, where they land, and how many graded
    // calls someone needs before the leaderboard will rank them.
    picks: {
      channelId: str('PICKS_CHANNEL_ID'),
      analystRoleIds: list('PICKS_ANALYST_ROLE_IDS'),
      defaultMinutes: int('PICKS_DEFAULT_MINUTES', 15),
      defaultAsset: str('PICKS_DEFAULT_ASSET', 'BTC'),
      minimumForBoard: int('PICKS_BOARD_MINIMUM', 5),
      // Roles pinged on every call. Defaults to every tier that has a role, so
      // the people paying for signals are the ones who get them.
      pingRoleIds: list('PICKS_PING_ROLE_IDS', [
        str('ROLE_TIER_1'),
        str('ROLE_TIER_2'),
        str('ROLE_TIER_3'),
      ].filter(Boolean)),
      disclaimer: str('PICKS_DISCLAIMER', 'Not financial advice'),
      // Put the console back under the channel after a call closes, so the next
      // signal is never fifty messages away from the button that sends it.
      repostPanel: bool('PICKS_REPOST_PANEL', true),
      // The chat that gets the one-line version. The full embed is a wall on a
      // phone, and the room that is talking is not the room reading levels.
      announceChannelId: str('PICKS_ANNOUNCE_CHANNEL_ID'),
      // Where the room's own verdict is published once the voting closes.
      resultChannelId: str('PICKS_RESULT_CHANNEL_ID', str('PICKS_CHANNEL_ID')),
      voteMinutes: int('PICKS_VOTE_MINUTES', 20),
      // Who gets tagged when the room is asked how it went. Defaults to the
      // tiers that are in the room to answer — tier 1 buys signals, not chat.
      votePingRoleIds: list('PICKS_VOTE_PING_ROLE_IDS', [
        str('ROLE_TIER_2'),
        str('ROLE_TIER_3'),
      ].filter(Boolean)),
      // Scoring against the Kalshi contract rather than BTC spot. Off until the
      // response shape is confirmed against a live account with /picks kalshi.
      kalshi: {
        enabled: bool('KALSHI_ENABLED', false),
        apiBase: str('KALSHI_API_BASE'),
        seriesTicker: str('KALSHI_SERIES_TICKER'),
        side: str('KALSHI_SIDE', 'yes'),
        apiKeyId: str('KALSHI_API_KEY_ID'),
        // Reading the analyst's own account turns the record from "what he
        // says he did" into "what the exchange saw him do". The key can trade,
        // so it lives here and nowhere else — see src/picks/kalshiAccount.js.
        account: {
          keyId: str('KALSHI_API_KEY_ID'),
          // Multi-line PEM survives an environment variable badly, so \n is
          // accepted as an escape and turned back into real newlines.
          privateKeyPem: (str('KALSHI_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n') || null,
          apiBase: str('KALSHI_API_BASE'),
          seriesTicker: str('KALSHI_SERIES_TICKER'),
          autoPublish: bool('KALSHI_AUTO_PUBLISH', false),
          // How often the account is read. A 15-minute scalp loses value every
          // second the room hears about it late, and one small GET is cheap.
          pollSeconds: int('KALSHI_POLL_SECONDS', 3),
          // Whose calls these become. Without it the record has no owner.
          analystId: str('KALSHI_ANALYST_DISCORD_ID'),
          analystTag: str('KALSHI_ANALYST_TAG'),
        },
        // The account the bot may SPEND from, kept deliberately separate from
        // the one above.
        //
        // The account above belongs to the analyst whose fills get published;
        // it is read with a key that could trade, and the read path refuses to
        // sign anything but three portfolio endpoints so that it cannot. This
        // one is a different key for a different person, and the separation is
        // the point: a bug anywhere in the publishing path cannot reach a
        // credential that spends, and the analyst's key is never the one an
        // order is signed with.
        trading: {
          keyId: str('KALSHI_TRADING_KEY_ID'),
          privateKeyPem: (str('KALSHI_TRADING_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n') || null,
          apiBase: str('KALSHI_API_BASE'),
          // Whose money it is. Reports and every alert go here and nowhere else.
          ownerId: str('KALSHI_TRADING_OWNER_ID'),
          // The whole day's budget, in dollars. A ceiling, not a target.
          dailyLimitDollars: Number.parseFloat(str('KALSHI_DAILY_LIMIT', '20')),
          // Deliberately NOT settable from the environment. Arming is an
          // explicit act performed by a person in Discord, so that a copied
          // environment or a restored backup can never start a bot that trades.
        },
      },
    },
    // Card payments. Zelle is a one-off 30 days; Stripe bills again by itself
    // every period until the member cancels.
    stripe: {
      enabled: bool('STRIPE_ENABLED', false),
      secretKey: str('STRIPE_SECRET_KEY'),
      webhookSecret: str('STRIPE_WEBHOOK_SECRET'),
      webhookPath: str('STRIPE_WEBHOOK_PATH', '/stripe/webhook'),
      port: int('PORT', 3000),
      currency: str('STRIPE_CURRENCY', 'usd'),
      successUrl: str('STRIPE_SUCCESS_URL', `https://discord.com/channels/${guildId}`),
      cancelUrl: str('STRIPE_CANCEL_URL', `https://discord.com/channels/${guildId}`),
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
      // Which notification emails to read, and whose senders to trust for each.
      // Zelle has no safe default (every bank differs), Venmo does.
      providers: [
        { provider: 'zelle', allowedSenders: list('ZELLE_ALLOWED_SENDERS', list('IMAP_ALLOWED_SENDERS')) },
        { provider: 'venmo', allowedSenders: list('VENMO_ALLOWED_SENDERS') },
      ].filter((entry) => list('PAYMENT_PROVIDERS', ['zelle', 'venmo']).includes(entry.provider)),
    },
  };
}

/**
 * The signal engine's own bot.
 *
 * Separate application, separate token, separate server if you want one. The
 * VIP bot handles money and access; this one has opinions about markets. They
 * fail for different reasons and should not be able to take each other down.
 */
export function loadSignalConfig() {
  return {
    token: required('SIGNAL_BOT_TOKEN'),
    clientId: str('SIGNAL_BOT_CLIENT_ID'),
    guildId: str('SIGNAL_GUILD_ID', str('VIP_GUILD_ID')),
    channelId: str('SIGNAL_CHANNEL_ID'),
    asset: str('SIGNAL_ASSET', 'BTC'),
    seriesTicker: str('SIGNAL_SERIES_TICKER', str('KALSHI_SERIES_TICKER')),
    // Every 15-minute series to scan, "BTC:KXBTC15M,ETH:KXETH15M,BNB:KXBNB15M".
    // More markets is the honest growth lever: the edge per bet is capped by
    // the maths, the number of good bets a day is not.
    markets: str('SIGNAL_MARKETS'),
    // The most of the bankroll at risk across simultaneous signals. Crypto
    // moves together, so parallel crypto bets are closer to one big bet.
    maximumTotalFraction: Number.parseFloat(str('SIGNAL_MAX_TOTAL_FRACTION', '0.15')),
    apiBase: str('KALSHI_API_BASE'),
    storePath: str('SIGNALS_STORE_PATH', str('STORE_PATH', 'data/store.json')),
    sampleSeconds: int('SIGNALS_SAMPLE_SECONDS', 30),
    // Posting is off until the engine has earned it. Watching it call markets
    // in a mods-only channel for a couple of weeks costs nothing; publishing an
    // uncalibrated signal to people who pay for it costs the room.
    autoPost: bool('SIGNAL_AUTO_POST', false),
    // How often the live loop asks "now?". A scalp signal is worth less every
    // second it is late, and one small read is cheap.
    tickSeconds: int('SIGNAL_TICK_SECONDS', 5),
    roleIds: list('SIGNAL_PING_ROLE_IDS'),
    kellyFraction: Number.parseFloat(str('SIGNAL_KELLY_FRACTION', '0.25')),
    maximumFraction: Number.parseFloat(str('SIGNAL_MAX_FRACTION', '0.1')),
    engine: {
      minimumEdgeCents: int('SIGNAL_MIN_EDGE_CENTS', 4),
      minimumWorstCaseEdgeCents: int('SIGNAL_MIN_WORST_EDGE_CENTS', 2),
      maximumSpreadCents: int('SIGNAL_MAX_SPREAD_CENTS', 3),
      minimumLiquidityDollars: int('SIGNAL_MIN_LIQUIDITY', 25),
      sampleSeconds: int('SIGNALS_SAMPLE_SECONDS', 30),
    },
  };
}

export function loadPhotoConfig() {
  return {
    token: required('PHOTO_BOT_TOKEN'),
    avatarPath: str('PHOTO_BOT_AVATAR', 'assets/avatar-512.png'),
    username: str('PHOTO_BOT_USERNAME'),
    channelIds: list('PHOTO_ONLY_CHANNEL_IDS'),
    // A profits channel is screenshots with a word beside them: "+240%", "same
    // play as yesterday". Deleting the photo because of the caption throws away
    // the post people actually came to make, so captions ride along by default
    // and only bare text gets removed. Set it to false for a pure wall of
    // images.
    allowCaptions: bool('PHOTO_ONLY_ALLOW_CAPTIONS', true),
    allowVideos: bool('PHOTO_ONLY_ALLOW_VIDEOS', false),
    allowLinks: bool('PHOTO_ONLY_ALLOW_LINKS', false),
    ignoreBots: bool('PHOTO_ONLY_IGNORE_BOTS', true),
    bypassRoleIds: list('PHOTO_ONLY_BYPASS_ROLE_IDS'),
    bypassUserIds: list('PHOTO_ONLY_BYPASS_USER_IDS'),
    warn: bool('PHOTO_ONLY_WARN', true),
    warnSeconds: int('PHOTO_ONLY_WARN_SECONDS', 8),
    logChannelId: str('PHOTO_ONLY_LOG_CHANNEL_ID'),
  };
}

export const helpers = { str, bool, int, money, list };
