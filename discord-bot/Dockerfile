# Runs both bots in one container. Works on Railway, Fly.io, Render, Docker on a VPS.
FROM node:22-alpine

# Orders and payments live in a file, so the host must mount a persistent volume
# here. STORE_PATH defaults to this path; on a plain "docker run" the folder is
# just part of the container and disappears with it.
ENV STORE_PATH=/data/store.json
ENV NODE_ENV=production

# su-exec drops root once the volume has been handed over. See the entrypoint.
RUN apk add --no-cache su-exec

WORKDIR /app

# Dependencies first: this layer is cached while only the source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY assets ./assets
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app

# Deliberately NOT `USER node`. A Railway volume is mounted as root and hides
# the directory this image prepared, so a container that starts unprivileged can
# never write to it — the bot came up fine and then failed on every single save
# with "EACCES: permission denied, open '/data/store.json.tmp'". The entrypoint
# starts as root purely to take ownership of that mount, then runs the bot as
# `node`, so nothing here actually serves Discord traffic as root.

# The Stripe webhook listens here. Only needed when card payments are on; with
# Zelle alone nothing has to reach the container.
EXPOSE 3000

# No VOLUME instruction on purpose: Railway rejects it ("docker VOLUME is not
# supported, use Railway Volumes") and it buys nothing anywhere else — mounting
# the volume at /data works the same with `docker run -v` or a Railway volume.

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
