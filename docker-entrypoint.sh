#!/bin/sh
set -e
mkdir -p /appdata /data
# Only re-chown /appdata (database + thumbnail cache) when ownership changed; the thumbnail
# cache can hold many files. /data is deliberately NOT chowned: your photo folders keep their
# ownership. PUID/PGID must be able to write to the folders users should upload to.
if [ "$(stat -c %u:%g /appdata)" != "${PUID}:${PGID}" ]; then
  chown -R "${PUID}:${PGID}" /appdata
fi
umask "${UMASK:-022}"
exec su-exec "${PUID}:${PGID}" "$@"
