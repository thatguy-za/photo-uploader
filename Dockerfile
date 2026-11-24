FROM node:24-alpine

# su-exec: drop to PUID/PGID. libheif-tools: heif-convert, used to turn uploaded HEIC into JPG.
RUN apk add --no-cache su-exec libheif-tools

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data APPDATA_DIR=/appdata PUID=1000 PGID=1000 UMASK=022
EXPOSE 8080
VOLUME ["/data", "/appdata"]

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
