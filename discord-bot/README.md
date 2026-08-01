# Discord bots: VIP memberships paid with Zelle + photos-only channel

Two independent bots in one project:

1. **VIP bot** — sells three membership tiers paid via Zelle. Every purchase generates a
   **random code** that the buyer writes in the Zelle memo; the bot reads the bank's
   notification email, finds the code, and grants the roles automatically.
2. **Photos-only bot** — in the channels you point it at, it deletes anything that is not
   a photograph (plain text, non-image files and, if you want, photos that come with text).

## VIP tiers

| Tier | Price | Roles granted |
|-------|--------|------------------|
| Tier 1 | $50 | Tier 1 |
| Tier 2 | $100 | Tier 1 + Tier 2 |
| Tier 3 | $200 | Tier 1 + Tier 2 + Tier 3 |

Tiers **stack**: tier 3 grants all three roles, tier 2 grants two, tier 1 grants one.
Prices are set in `.env` (`TIER_1_PRICE`, and so on).

## How the payment flow works

```
/vip buy tier:2
   -> the bot creates the order and replies privately:
      "Send $100.00 via Zelle to payments@yourdomain.com
       and put VIP-7K3QDM in the memo"

The buyer pays through Zelle with that code in the memo
   -> the bank sends the "Someone sent you $100.00 with Zelle" email
   -> the bot checks the mailbox every 60s, finds VIP-7K3QDM,
      verifies the amount and grants the Tier 1 and Tier 2 roles
   -> it DMs the buyer and writes the record to the log channel
```

Zelle has **no public API**, so detection works by reading the alert email your bank
sends, over IMAP. If you would rather not connect a mailbox, set `IMAP_ENABLED=false`
and confirm payments by hand with `/vip-admin confirm`.

### Safeguards the bot applies

- Only emails from the senders in `IMAP_ALLOWED_SENDERS` (your bank) are read. Without
  that allowlist, anyone who emails you the right wording could trigger a fake payment:
  **always configure it**.
- The amount has to cover the tier price (`AMOUNT_TOLERANCE` allows a margin).
- Each email is processed once and each order is paid once.
- Codes expire after `ORDER_TTL_HOURS` hours.
- If someone overpays they get the highest tier the amount covers
  (`UPGRADE_ON_OVERPAY=false` turns this off).

## Setup

```bash
cd discord-bot
npm install
cp .env.example .env      # then fill it in
npm start                 # starts both bots
```

You can also run them separately: `npm run start:vip` / `npm run start:photo`.

### 1. Create the applications in Discord

At https://discord.com/developers/applications create **two** applications (one per bot)
and copy each token from the *Bot* tab:

- VIP bot → `VIP_BOT_TOKEN`, and the *Application ID* → `VIP_CLIENT_ID`.
  Enable the **Server Members Intent** (it needs it to assign roles).
- Photos bot → `PHOTO_BOT_TOKEN`. Enable the **Message Content Intent**
  (without it, it cannot tell whether a message contains text).

Invite them with the `bot applications.commands` scope and these permissions:

- VIP bot: *Manage Roles*, *Send Messages*, *Use Application Commands*.
- Photos bot: *Manage Messages*, *Read Message History*, *Send Messages*.

**Important:** in *Server Settings → Roles*, drag the VIP bot's role **above** the three
VIP roles, or Discord will not let it assign them. The bot warns you in the console at
startup if it detects this problem.

### 2. Copy the IDs

Turn on *User Settings → Advanced → Developer Mode*, then right click → *Copy ID* on the
server, the roles and the channels.

### 3. Set the profile picture

The KING T PARLAYS artwork is in `assets/`, already adapted to the square avatar
Discord expects:

| File | Use |
|------|-----|
| `logo-source.png` | the original wide artwork |
| `avatar-1024.png` / `avatar-512.png` / `avatar-256.png` | square avatars |
| `avatar-preview.png` | how it looks once Discord rounds it into a circle |

Discord crops avatars into a circle, so the wide logo would lose the `K` and the `S`
if it were pasted edge to edge. `assets/make-avatar.py` measures where the logo's ink
actually is, scales it to the largest size that fits fully inside the circle, and sets
it on a backdrop taken from the artwork itself (blurred, so the marble tone and gold
bloom survive without the letters showing through). Re-run it if you ever change the
logo:

```bash
pip install pillow numpy
python3 assets/make-avatar.py
```

Apply the avatar to whichever bots have a token configured:

```bash
npm run avatar
```

It reads `VIP_BOT_AVATAR` / `PHOTO_BOT_AVATAR` (both default to `assets/avatar-512.png`)
and, if set, also renames the bot to `VIP_BOT_USERNAME` / `PHOTO_BOT_USERNAME`. Discord
only allows a couple of avatar changes per hour per bot; the script tells you when you
have hit that limit. You can also just upload the PNG by hand in the developer portal.

### 4. Connect the bank mailbox

With Gmail: turn on two-step verification and create an
[app password](https://myaccount.google.com/apppasswords); that is what goes into
`IMAP_PASSWORD` (never the account's normal password).

Put the address your bank sends Zelle alerts from into `IMAP_ALLOWED_SENDERS` (open a
real alert email and copy the sender). Common examples:

```
IMAP_ALLOWED_SENDERS=alerts@notify.wellsfargo.com,no.reply.alerts@chase.com,email.zellepay.com
```

If your bank words its alerts differently, adjust the patterns in
`src/payments/parseZelle.js` (`RECEIVED_PATTERNS`) and add a case to
`test/parseZelle.test.js` using the real email text.

## Commands

**For everyone**

| Command | What it does |
|---------|----------|
| `/vip prices` | Shows the three tiers and what each one includes |
| `/vip buy tier:<1-3>` | Generates the code and the payment instructions |
| `/vip status` | Shows your orders and their status |
| `/vip cancel [code]` | Cancels one of your pending orders |

**For staff** (needs the *Manage Roles* permission or a role from `VIP_ADMIN_ROLE_IDS`)

| Command | What it does |
|---------|----------|
| `/vip-admin confirm code:<> [amount] [note]` | Applies a payment by hand and grants the roles |
| `/vip-admin lookup code:<>` | Full record of an order |
| `/vip-admin pending` | Orders still awaiting payment |
| `/vip-admin cancel code:<>` | Cancels anyone's order |
| `/vip-admin sync` | Checks the mailbox right now instead of waiting for the next poll |

## Photos-only channel

Put the channel IDs in `PHOTO_ONLY_CHANNEL_IDS` (comma-separated). Any message that does
not comply is deleted, and the bot leaves a notice that self-destructs after
`PHOTO_ONLY_WARN_SECONDS` seconds.

| Variable | Default | Effect |
|----------|-------------|--------|
| `PHOTO_ONLY_ALLOW_CAPTIONS` | `false` | When `false`, not even text next to the photo is allowed |
| `PHOTO_ONLY_ALLOW_VIDEOS` | `false` | Also allow videos |
| `PHOTO_ONLY_ALLOW_LINKS` | `false` | Allow image links with no attachment |
| `PHOTO_ONLY_BYPASS_ROLE_IDS` | empty | Roles that may post text (moderators) |
| `PHOTO_ONLY_LOG_CHANNEL_ID` | empty | Channel to log what was deleted |

It also watches **edits**: if someone posts a valid photo and then edits text into it,
the message is deleted all the same.

## Layout

```
assets/                  logo, generated avatars and make-avatar.py
src/
  config.js              reads and validates .env
  index.js               starts both bots
  deployCommands.js      registers the slash commands without starting the bot
  setAvatar.js           uploads the profile picture (npm run avatar)
  bots/vipBot.js         VIP bot client
  bots/photoBot.js       photos-only bot client
  lib/brand.js           embed colours
  lib/codes.js           random code generation and detection
  lib/tiers.js           prices and the stacking tier rule
  lib/store.js           JSON persistence (data/store.json)
  payments/parseZelle.js reading the bank's email
  payments/zelleWatcher.js  periodic IMAP mailbox polling
  vip/orders.js          order lifecycle
  vip/roles.js           role assignment
  vip/paymentFlow.js     payment -> order -> roles -> notifications
  vip/commands.js        slash commands
  photo/photoOnly.js     the rule for what a photos channel accepts
test/                    tests (node --test)
```

Data lives in `data/store.json` (orders, payments and already-processed emails).
That file is in `.gitignore`: **back it up** if the history matters to you.

## Tests

```bash
npm test
```

They cover code generation and detection, the stacking tier rule, Zelle email parsing
(including spoofing attempts and outgoing-payment alerts), the order lifecycle, and the
full payment flow against a stubbed Discord client.
