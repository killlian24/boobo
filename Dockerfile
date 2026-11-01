# Boobo – minimaler Still-Tracker
# Keine npm-Abhängigkeiten, daher kein `npm install`: es wird nur kopiert.
FROM node:24-alpine

WORKDIR /app

# Alles Nötige kopieren (server.js, package.json, public/, optional lib/).
# Was NICHT ins Image soll, steht in .dockerignore (data, test, docs, .git, …).
COPY --chown=node:node . .

ENV PORT=8099 \
    DATA_DIR=/data \
    TZ=Europe/Berlin \
    NODE_ENV=production

# openssl erzeugt beim ersten Start die eigene Zertifizierungsstelle für HTTPS (siehe README).
# Datenverzeichnis für SQLite und Zertifikate; gehört dem unprivilegierten User `node` (uid 1000).
RUN apk add --no-cache openssl && mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 8099 8443
VOLUME ["/data"]

# wget ist Teil von BusyBox in Alpine – kein zusätzliches Paket nötig.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8099/api/health || exit 1

CMD ["node", "server.js"]
