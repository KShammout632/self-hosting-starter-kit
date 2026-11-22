# Built on the server by install.sh from the files in /opt/selfhost/dashboard.
# api.js is a single bundle. Only the two native modules are installed here.
FROM node:22.23.3-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY api.js ./
COPY web ./web
# The app runs as an unprivileged user, so the files must be readable whatever permissions they had
# in the build folder.
RUN chmod -R a+rX /app/web

ENV NODE_ENV=production \
    SELFHOST_WEB_DIR=/app/web

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "api.js"]
