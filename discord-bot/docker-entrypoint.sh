#!/bin/sh
set -e

# A mounted volume replaces whatever the image built at that path, and it
# arrives owned by root. The chown in the Dockerfile applies to a directory
# that no longer exists once the volume is attached, so the bot — running as
# `node` — gets EACCES on its very first write and loses every payment and
# membership it was about to record.
#
# So the fix has to happen at runtime, on every start: take ownership while
# still root, then drop to `node` for the process that actually runs.

DIR=$(dirname "${STORE_PATH:-/data/store.json}")
mkdir -p "$DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DIR" || echo "[entrypoint] Could not take ownership of $DIR — writes may fail"
  exec su-exec node "$@"
fi

# Already unprivileged. Nothing to hand over; if the directory is not writable
# the store's own startup probe reports it in terms the owner can act on.
exec "$@"
