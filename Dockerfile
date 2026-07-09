FROM node:24-slim

# paris-hunter: this image is API-only (FREDY_SKIP_CHROMIUM=true — our single
# provider implements getListings, so Fredy never launches a browser).
# The upstream CloakBrowser system-deps + font block and the Chromium
# pre-download layer are deliberately dropped: smaller image, no 140MB binary.
# Build tools (python3 make g++) are only needed to compile better-sqlite3;
# sharp ships prebuilt binaries. curl stays for the HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /db /conf /data/convos /fredy

WORKDIR /fredy

ENV NODE_ENV=production \
    IS_DOCKER=true \
    FREDY_SKIP_CHROMIUM=true

COPY package.json yarn.lock ./

# Install dependencies and purge build tools (only needed to compile better-sqlite3)
RUN yarn config set network-timeout 600000 \
  && yarn --frozen-lockfile \
  && yarn cache clean

# Purge build tools now that native modules are compiled
RUN apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY index.html vite.config.js ./
COPY ui ./ui
COPY lib ./lib

RUN yarn build:frontend

COPY index.js ./
# paris-hunter operator tools (bootstrap/seed/setup-bucket/QA) must ship in the
# image so `docker compose run --rm fredy node tools/paris-hunter/<tool>.js` works.
COPY tools ./tools

# conf/ is NOT baked into the image (.dockerignore): /conf is a volume;
# refreshConfig() writes conf/config.json with defaults on first boot.
RUN ln -s /db /fredy/db \
  && ln -s /conf /fredy/conf

EXPOSE 9998
VOLUME /db
VOLUME /conf

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:9998/ || exit 1

CMD ["node", "index.js"]
