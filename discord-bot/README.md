# Discord bots: VIP memberships paid with Zelle + photos-only channel

Two independent bots in one project:

1. **VIP bot** — sells three membership tiers paid via Zelle. Every purchase generates a
   **random code** that the buyer writes in the Zelle memo; the bot reads the bank's
   notification email, finds the code, and grants the roles automatically.
2. **Photos-only bot** — in the channels you point it at, it deletes anything that is not
   a photograph (plain text, non-image files and, if you want, photos that come with text).

## VIP tiers

| Tier | Price | What it includes | Roles granted |
|-------|--------|------------------|------------------|
| Tier 1 · Signals | $50 | Every signal as it drops | Tier 1 |
| Tier 2 · VIP | $100 | The above + the VIP room with everyone and the elites | Tier 1 + 2 |
| Tier 3 · Elite | $200 | The above + private lessons and calls with the elites | Tier 1 + 2 + 3 |

The names and the sales copy shown in `/vip prices` and `/vip buy` come from
`TIER_n_LABEL` and `TIER_n_PERKS`, so they can be reworded from the hosting dashboard
without touching code — use `|` to separate bullet lines.

Tiers **stack**: tier 3 grants all three roles, tier 2 grants two, tier 1 grants one.
Prices are set in `.env` (`TIER_1_PRICE`, and so on).

A tier with no `ROLE_TIER_n` configured is treated as **coming soon**: it never shows
up in `/vip buy` and is listed as locked in `/vip prices`, so nobody can pay for a role
the bot cannot hand out. Add the role ID later and it goes on sale by itself.

## Ways to pay

`/vip buy` offers both in the same private reply:

| | **💳 Card (Stripe)** | **🏦 Zelle / 💸 Venmo** |
|---|---|---|
| How it renews | Charges the card automatically every period until cancelled | One payment, renewed by hand |
| Reminders | None needed — it pays itself | DM 3 days and 1 day before it ends |
| If it lapses | Stripe reports the cancellation, the bot removes the roles | The roles come off when the time runs out |
| Fees | ~2.9% + $0.30 per charge | none |
| Setup | Stripe key + webhook (see [DEPLOY.md](DEPLOY.md)) | just an email, phone or handle |

Zelle and Venmo are detected identically: neither has a public API for personal
accounts, so the bot reads the notification email and matches the code in the note.
Venmo only needs `VENMO_RECIPIENT`; its sender allowlist already defaults to
`venmo@venmo.com`.

**Anything not configured shows up as "coming soon"** in `/vip buy` and `/vip prices`
rather than being silently missing, and the tease disappears on its own the moment that
method is set up.

The card plan is built from `TIER_n_PRICE` and `SUBSCRIPTION_DAYS` at checkout time, so
nothing has to be created in the Stripe dashboard and the two payment methods can never
charge different amounts. With no Stripe key configured the bot is simply Zelle-only and
the card button does not appear.

Card memberships are reconciled against Stripe before anyone is revoked: if a renewal
webhook goes missing, the bot asks Stripe directly rather than taking the roles off a
member who actually paid.

## Memberships are 30 days

Every payment buys `SUBSCRIPTION_DAYS` (30 by default) of access, not a permanent role.

- The buyer is told the exact expiry date when they pay, and can check it any time with
  `/vip status`.
- The bot **DMs a reminder** 3 days and 1 day before it runs out
  (`SUBSCRIPTION_REMINDER_DAYS`). Each reminder is sent once; if the bot was offline it
  sends only the most urgent one rather than a burst.
- When the time is up it **removes the VIP roles automatically** and DMs the member.
  `SUBSCRIPTION_GRACE_DAYS` adds slack before that happens.
- **Renewing early stacks**: paying with 10 days left gives 40, so nobody is punished
  for renewing ahead of time. Renewing into a higher tier upgrades; buying a lower tier
  only adds time and never demotes.
- Somebody who left the server is expired quietly — there are no roles to take back.

Mods see every active membership with `/vip-admin members` and can end one immediately
with `/vip-admin revoke` (useful for a Zelle chargeback).

## The storefront

`/vip-admin panel` posts a buttoned storefront: a button per tier that opens the
purchase instructions privately, one for the member's own membership, and one to open a
ticket. Nobody has to know a command exists, which is most of the reason people never
buy.

Every new member is also **DM'd the same storefront when they join** (`WELCOME_DM`),
minus the ticket button — a ticket needs a guild and a DM has none — plus a link back to
the server. Those buttons work from the DM: the guild falls back to the one the bot
serves.

Tiers that are coming soon appear in the list but have no button to press.

## Buying from outside the server

Discord will not let anyone DM a bot they share no server with, so "DM the bot to get in"
is not by itself an instruction a stranger can follow. Two things make it one:

1. **`/vip` is user-installable.** It declares both integration types and works in a DM,
   so somebody can add the app to their own account from an install link and run
   `/vip buy` without joining anything first.
2. **A payment from a non-member is still a membership.** The roles cannot be handed over
   to somebody who is not there, so the purchase is recorded, the buyer is DMed
   `SERVER_INVITE_URL`, and the roles land the moment they walk in.

**Anyone who writes to the bot gets answered.** A DM from somebody the bot has not
spoken to recently is replied to with the storefront and the invite — somebody who
messages a sales bot is asking one question, and making them wait for a person loses
most of them. One reply per person per `DM_REPLY_COOLDOWN_HOURS` (24 by default), so
three messages in a row do not get three storefronts, and the bot never answers itself.
Each one is reported to the log channel so inbound interest is visible.

This needs the **Direct Messages** intent, which is not privileged. The message text is
never read — only that somebody wrote — so Message Content stays off.

That makes the poster copy true: *install the app, DM the bot, pay, join.* The plain
invite still works too — anyone who joins first is DMed the storefront on arrival.

## Tickets

`/vip-admin panel` posts a button members press when a payment has not landed. It opens
a **private channel** — the member, the mods and nobody else — pings the mod roles, and
leads with the context somebody would otherwise have to go dig for: the member's
membership state, their last order codes, and the exact `/vip-admin confirm` line that
applies the payment. Clicking twice reuses the channel they already have; mods close it
from a button, which deletes it.

The bot needs **Manage Channels** for this. `TICKET_CATEGORY_ID` files the tickets under
a category.

Note that payments arriving with **no VIP code** are never posted to Discord: the watched
inbox also carries the owner's personal transfers, and those are nobody's business.
`LOG_UNMATCHED_PAYMENTS=true` brings them back if you want them.

## Cleaning a channel's history

The rule above only applies to new messages. `/photo-clean` applies it to what is
already there — deleting every text message in a photos-only channel and leaving the
photos.

```
/photo-clean channel:#photos                 preview: says what it would delete
/photo-clean channel:#photos confirm:True    actually deletes it
```

Without `confirm` it only counts, because a channel's history does not come back and
the preview is the one chance anyone has to notice the number is wrong. **Pinned
messages are kept** even when they are text (`keep_pinned:False` to sweep those too),
since a pin is usually the channel rules somebody meant to outlast everything else.

Two role filters narrow who is in scope, and both are decided before the photo rule
gets a say:

```
/photo-clean channel:#photos except_from:@MOD      keeps everything the mods posted
/photo-clean channel:#photos only_from:@Tier 1     only sweeps that role, leaves the rest
```

`except_from` exempts a role outright — a mod's plain text survives. `only_from` does
the opposite: nobody without that role is touched at all. They combine, and the
exemption wins when a member holds both, because that is the safer reading of the two.

Since tiers stack, `only_from:@Tier 1` covers every paying member: a Tier 3 buyer holds
the Tier 1 role too. Someone who has **left the server** carries no roles, so `only_from`
never sweeps them.

It uses the very same rule as live enforcement, so a cleanup can never delete something
the channel would allow straight back in. Discord refuses to bulk-delete messages over
14 days old, so those are removed one at a time and it takes a while — the reply says
how many are in that group before you commit.

The bot needs **View Channel**, **Read Message History** and **Manage Messages** on that
channel; it names whichever is missing rather than failing halfway.

## Trading calls and track records

A room full of "up" and "down" is only worth paying for if somebody is counting.

```
/call direction:🟢 UP minutes:15 entry:97200 note:reclaimed the range low
```

The call is posted with its direction, window and levels. When the window closes the
bot comes back and asks the analyst to grade it — Win, Loss, Break even or Void — and
the result is written onto the original call for everyone to see.

```
/picks record              your own record, or someone else's
/picks board               the leaderboard by win rate
/picks open                what is still running
```

Three decisions worth knowing, because they are what make the numbers mean anything:

- **Break-evens and voids are counted but kept out of the win rate.** A call that went
  nowhere is neither a hit nor a miss, and folding it into either would let anyone
  improve their percentage by calling nothing.
- **The leaderboard holds back anyone under `PICKS_BOARD_MINIMUM` graded calls** (5 by
  default) and lists them separately. One lucky call is 100%, and ranking that above
  someone at 62% over forty calls would make the board actively misleading.
- **A graded call cannot be regraded.** The analyst grades their own calls and mods can
  step in when someone is away, since an ungraded call sits in "open" forever and
  quietly flatters whoever made it.

### The analyst console

```
/picks panel
```

Posts a button console and pins-worthy. Typing `/call direction:… minutes:… entry:…` is
four decisions at the exact moment there is no time to make them; on a 15-minute market
the signal is worth less the longer it takes to send.

| Button | What the room gets |
| --- | --- |
| 🟢 **BUY UP** / 🔴 **BUY DOWN** | Asks how much of the port goes in, then opens the call at the live price |
| 💰 **CASH AT %** | Asks for the percentage, then tells the room to take that much off |

| 💸 **CRASH OUT** | Everything out with the profit; the call ends and is scored |
| ❌ **CUT LOSS** | Everything out at a loss |
| ✋ **HOLD** | Stay in, nothing has changed |

Cutting a loss is a button because a console that can only announce wins teaches the
room to sit through the losers.

**There is no partial exit**, because Kalshi has none: you sell the contracts you hold,
not a quarter of them. The percentages belong to the *entry* — how much of the book goes
in — and the exit is one button that takes everything.

Cash-out and hold messages are posted as replies to the analyst's own open call, since a
bare "cash out" is unreadable in a channel where three calls are running.

### Tell the room what the buttons mean

```
/picks guide
```

Posts an announcement explaining every signal, in plain words, and **pin it**. "Take 50%
off" and "all out" are the same word — *cash* — to somebody who has not traded before,
and a member who reads them as the same thing sits in a position the analyst has already
left.

After a call closes the console is **posted again** at the bottom of the channel
(`PICKS_REPOST_PANEL`). A pinned panel is fifty messages up by the time it matters, and
the next signal is the one nobody should have to go hunting for.

Mods can press everything the analysts can — `VIP_MOD_ROLE_IDS` counts as an analyst role
here, so nobody is locked out of their own room.

### A call ends when the analyst says it ends

Cashing out or cutting a loss **closes the call and scores it at that price**. The exit
is the moment the analyst gets out, not fifteen minutes later — grading on the window
while ignoring the exit marks a call somebody took profit on as a loss because price
kept going afterwards.

**HOLD** changes nothing, so it leaves the call running. **CASH AT %** is a partial take
and also leaves it open.

Windows **snap to the candle**: a 15-minute call opened at 3:41 closes at 3:45, not
3:56, so the bot's clock is the clock the room is trading. A boundary less than a minute
away is skipped, since a call with eleven seconds left in it is not a call.

### Calls grade themselves

Kalshi is where these get traded, but a 15-minute "up or down" is settled by the
underlying price, so that is what is wired in. Every call is stamped with the spot price
when it opens; when the window closes the bot reads the price again and posts the result
itself.

Three exchanges are tried in turn — Coinbase, Kraken, Binance — because a call that
cannot be graded on account of one venue having a bad minute is worse than asking a
second. A move under 0.02% counts as **break even** rather than a win: settling a drift
of a few dollars as a correct call would inflate every record on the board.

If no price can be read at all, the call falls back to the analyst pressing a button.
Nothing is silently dropped. Check the feed any time with:

```
/picks price
```

**Every call pings the VIP tier roles**, and so does every cash-out, cut-loss and hold —
the people paying for signals are the ones who have to see them. This defaults to
whichever `ROLE_TIER_n` are configured; `PICKS_PING_ROLE_IDS` overrides it, and setting
it empty turns pinging off. `allowedMentions` is always set explicitly, so whatever ends
up inside an embed the bot can never reach `@everyone`.

**`PICKS_ANALYST_ROLE_IDS` is not optional.** With no analyst role configured only
administrators can press anything: Manage Messages is held by every moderator in most
servers, and a member pressing BUY UP by accident sends a real signal to everyone paying
for one.

If a call is scored wrongly, a mod can change it:

```
/picks edit call:<start typing> outcome:✅ Win reason:cashed before the candle turned
```

The picker searches by what a mod would recognise — the time, the side, how it was
scored — because nobody knows a call's id. Editing keeps the original verdict, who
changed it and why, posts the correction in the channel, and rewrites the original
message so scrolling back does not show the old result. **A public number cannot be
changed quietly**: an edit that left no trace would be a way to launder a record rather
than correct one.

`/picks reset analyst:@them` wipes a whole record instead, previewing what it would
delete before `confirm:True` does it. Both are mods only.

Set `PICKS_ANALYST_ROLE_IDS` to the roles allowed to post calls. `PICKS_CHANNEL_ID`
sends every call to one channel; without it they land wherever the command was run.

## Who can administer the bot

`/vip-admin` is for staff only. Set `VIP_MOD_ROLE_IDS` to your MOD role ID (comma
separated for several) and **only** those roles can confirm payments, revoke
memberships or cancel orders. Anyone with the Discord **Administrator** permission also
passes, so a server owner cannot lock themselves out of their own bot.

While `VIP_MOD_ROLE_IDS` is empty the bot falls back to the *Manage Roles* permission,
so it stays usable before you configure it — set the variable to lock it down.

Admin answers are **ephemeral**: only the mod who ran the command sees them. Add
`share:true` to any of them to post the answer in the channel instead, for when the
point is to show the rest of the team — the numbers, who is expiring, what a payment
looked like. It is off unless asked for, because these replies carry member names and
payment history.

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

### When the bank does not forward the memo

Plenty of banks — Huntington among them — say who paid and how much and never repeat
the note the payer typed. The code never reaches the bot, so it falls back to the
amount:

The alert still names the payer, so the buyer is asked for that name when they pick a
tier — one short modal, before the code is issued. Matching then runs in this order:

| What the bot has | What it does |
| --- | --- |
| The code, in the memo | Applies it. Always wins when the bank forwards the note |
| A payer name matching one waiting order | Applies it, however old the order is |
| Several orders claiming that name | Posts them to the log channel for a mod to pick |
| No name given, one order for that exact amount placed minutes ago | Applies it |
| A payment worth exactly a tier price that fits none of the above | Posts it with a member picker so a mod assigns it in one click |
| Anything else | Ignores it — that is the owner's own Zelle activity |

Names are compared forgivingly enough for "Chris Swails" to match `CHRISTOPHER SWAILS`
and strictly enough that a differing surname never matches. A name that is given and
does not match rules an order out rather than leaving it merely unproven, so one
person's payment can never be handed to another.

Amount-only matching stays deliberately short-lived (`AMOUNT_MATCH_WINDOW_MINUTES`,
3 h by default): over days an amount stops being evidence of anything. Set
`MATCH_BY_AMOUNT=false` to require the code and nothing else.

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

That runs the bots on your own machine, which is fine for testing but stops the moment
you close the terminal. To keep them online around the clock see [DEPLOY.md](DEPLOY.md)
— there is a `Dockerfile` ready for Railway, Fly.io or any VPS.

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
`IMAP_PASSWORD` (never the account's normal password). An app password only works for
the account that created it, so make sure you are signed in as the mailbox in
`IMAP_USER` when you generate it.

There is nothing to switch on: Gmail removed its enable/disable IMAP setting in January
2025 and IMAP is now always available. If sign-in fails, it is the password, not a
setting — `/vip-admin sync` names the failing step and quotes the server.

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

**For staff** (needs a role from `VIP_MOD_ROLE_IDS`, or the Administrator permission)

| Command | What it does |
|---------|----------|
| `/vip-admin confirm code:<> [amount] [note]` | Applies a payment by hand and grants the roles |
| `/vip-admin lookup code:<>` | Full record of an order |
| `/vip-admin pending` | Orders still awaiting payment |
| `/vip-admin cancel code:<>` | Cancels anyone's order |
| `/vip-admin sync` | Checks the mailbox right now instead of waiting for the next poll |
| `/vip-admin members` | Every active membership and when it expires |
| `/vip-admin revoke user:<> [reason]` | Ends a membership now and takes the roles back |

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
  lib/subscriptions.js   membership expiry, renewals and reminder timing
  lib/codes.js           random code generation and detection
  lib/tiers.js           prices and the stacking tier rule
  lib/store.js           JSON persistence (data/store.json)
  payments/parseZelle.js reading the bank's email
  payments/zelleWatcher.js  periodic IMAP mailbox polling
  vip/orders.js          order lifecycle
  vip/roles.js           role assignment
  vip/paymentFlow.js     payment -> order -> roles -> membership -> notifications
  vip/subscriptions.js   membership records
  vip/subscriptionSweeper.js  reminders and automatic role removal
  vip/notify.js          DMs and the audit channel
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
(including spoofing attempts and outgoing-payment alerts), the order lifecycle, the
membership rules (expiry, early renewal stacking, reminder timing, grace period, members
who left the server, closed DMs) and the full payment flow against a stubbed Discord
client.
