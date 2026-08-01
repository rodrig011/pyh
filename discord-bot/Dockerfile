# Runs both bots in one container. Works on Railway, Fly.io, Render, Docker on a VPS.
FROM node:22-alpine

# Orders and payments live in a file, so the host must mount a persistent volume
# here. STORE_PATH defaults to this path; on a plain "docker run" the folder is
# just part of the container and disappears with it.
ENV STORE_PATH=/data/store.json
ENV NODE_ENV=production

WORKDIR /app

# Dependencies first: this layer is cached while only the source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY assets ./assets

RUN mkdir -p /data && chown -R node:node /data /app
USER node

# No VOLUME instruction on purpose: Railway rejects it ("docker VOLUME is not
# supported, use Railway Volumes") and it buys nothing anywhere else — mounting
# the volume at /data works the same with `docker run -v` or a Railway volume.

CMD ["node", "src/index.js"]
