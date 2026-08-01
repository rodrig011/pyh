# Running the bots 24/7 (no laptop required)

The bots only work while the process is running. On your own machine that means the
bots die when you close the terminal or the lid. To keep them online you put them on a
host that never sleeps.

Everything here uses the `Dockerfile` in this folder, so the same setup works on
Railway, Fly.io, Render or any VPS with Docker.

## What the host must provide

- **Node 22 / Docker** — covered by the Dockerfile.
- **A persistent disk mounted at `/data`.** Orders, payments and the list of
  already-processed emails live in `data/store.json`. Hosts that wipe the filesystem on
  every restart would lose the pending codes and the record of who paid. `STORE_PATH`
  already points at `/data/store.json` inside the image; you just have to attach the
  volume.
- **No inbound ports.** The bots dial out to Discord; nothing needs to reach them, so
  there is no web service to expose and no domain to configure.

## Option A — Railway (no terminal)

1. Sign in at [railway.app](https://railway.app) with GitHub.
2. **New Project → Deploy from GitHub repo → `rodrig011/pyh`**.
3. Open **Settings** and set:
   - **Root Directory**: `discord-bot` — the repo root is a website, the bots live in
     this subfolder.
   - **Branch**: the branch that carries the bot code.
4. **Variables** → add the same keys the `.env` file would hold. This replaces `.env`
   entirely; there is no file to edit. At minimum:

   ```
   VIP_BOT_TOKEN, VIP_CLIENT_ID, VIP_GUILD_ID,
   ROLE_TIER_1, ROLE_TIER_2, ROLE_TIER_3,
   ZELLE_RECIPIENT,
   PHOTO_BOT_TOKEN, PHOTO_ONLY_CHANNEL_IDS
   ```

   Leave `STORE_PATH` alone; the image already sets it.
5. **Volumes → New Volume**, mount path `/data`. Do this before going live, or the
   first restart takes your data with it.
6. Deploy. The **Logs** tab should show `Logged in as ...` and
   `Slash commands registered in the guild`.

Redeploys happen on every push to that branch.

## Option B — VPS (Hetzner, DigitalOcean, any Ubuntu box)

```bash
ssh root@your-server
apt update && apt install -y docker.io git
git clone https://github.com/rodrig011/pyh.git
cd pyh/discord-bot
nano .env                     # paste the variables, save with Ctrl+O then Ctrl+X

docker build -t vipbot .
docker run -d --name vipbot \
  --restart unless-stopped \
  --env-file .env \
  -v vipbot-data:/data \
  vipbot
```

`--restart unless-stopped` brings the bots back after a crash or a reboot.
`-v vipbot-data:/data` is the persistent disk.

Useful afterwards:

```bash
docker logs -f vipbot     # watch the logs
docker restart vipbot     # restart
cd pyh && git pull && cd discord-bot && docker build -t vipbot . && \
  docker rm -f vipbot && docker run -d --name vipbot --restart unless-stopped \
  --env-file .env -v vipbot-data:/data vipbot   # deploy an update
```

## Turning on card payments (Stripe)

Zelle needs nothing public — the bot dials out. Card payments do: Stripe has to be able
to reach the bot to say "this person paid". That is the only reason the container
listens on a port.

1. **Get the key.** Stripe dashboard → *Developers → API keys* → copy the **secret key**
   (`sk_test_…` while you try it out, `sk_live_…` when you go live).
2. **Give the service a public address.** Railway → service → *Settings → Networking →
   Generate Domain*. You get something like `heroic-freedom-production.up.railway.app`.
   On a VPS, publish the port and put it behind HTTPS.
3. **Create the webhook.** Stripe dashboard → *Developers → Webhooks → Add endpoint*:
   - URL: `https://<your-domain>/stripe/webhook`
   - Events: `checkout.session.completed`, `invoice.paid`,
     `customer.subscription.deleted`, `customer.subscription.updated`
   - Copy the **signing secret** (`whsec_…`).
4. **Set the variables** and redeploy:

   ```
   STRIPE_ENABLED=true
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

The signing secret is not optional. Without it the bot refuses every card event, on
purpose: an unverified endpoint would let anyone who finds the URL POST a fake "payment
succeeded" and hand themselves a role. The bot answers 400 to anything it cannot verify
and 500 when handling fails, which makes Stripe retry rather than drop the payment.

Nothing else needs configuring in Stripe — no products, no prices. The plan is built
from `TIER_n_PRICE` and `SUBSCRIPTION_DAYS` at checkout time, so the card plan can never
drift away from the Zelle one.

To check it end to end, use Stripe's test mode with card `4242 4242 4242 4242`, then
watch the deploy logs for `Stripe checkout.session.completed -> activate: granted`.

## Backing up the data

The store is a single JSON file. On a VPS:

```bash
docker cp vipbot:/data/store.json ./store-backup.json
```

Worth doing before any risky change — it holds every pending code and the payment
history.

## Things that bite

- **No volume mounted** → every restart forgets the pending orders. Attach it first.
- **Railway rejects a `VOLUME` instruction** in the Dockerfile ("docker VOLUME at
  Line N is not supported, use Railway Volumes"). That is why there isn't one here;
  mounting a volume at `/data` from the platform side is all it takes.
- **Railway's Root Directory has to be saved, not staged.** If a build's logs mention
  `railpack` or `RAILPACK_SPA_OUTPUT_DIR`, it never used the Dockerfile — it tried to
  build the repo root instead. Set Root Directory to `discord-bot`, Builder to
  `Dockerfile` and Dockerfile Path to `Dockerfile` (relative to the root directory).
- **Editing variables** requires a restart of the service to take effect.
- **The bot's role must sit above the three VIP roles** in the server settings. This is
  unrelated to hosting, but it is the most common reason a correctly deployed bot still
  fails to hand out roles. The startup logs warn you when it is wrong.
- **Do not commit `.env`.** It is gitignored. On Railway the variables live in the
  dashboard; on a VPS the file stays on the server only.
