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

## Backing up the data

The store is a single JSON file. On a VPS:

```bash
docker cp vipbot:/data/store.json ./store-backup.json
```

Worth doing before any risky change — it holds every pending code and the payment
history.

## Things that bite

- **No volume mounted** → every restart forgets the pending orders. Attach it first.
- **Editing variables** requires a restart of the service to take effect.
- **The bot's role must sit above the three VIP roles** in the server settings. This is
  unrelated to hosting, but it is the most common reason a correctly deployed bot still
  fails to hand out roles. The startup logs warn you when it is wrong.
- **Do not commit `.env`.** It is gitignored. On Railway the variables live in the
  dashboard; on a VPS the file stays on the server only.
