# paris-hunter: the Debian suite is pinned explicitly (trixie = Debian 13,
# glibc 2.41). The @xmtp/node-bindings linux-*-gnu native binaries (node-sdk
# 6.0.0 -> node-bindings 1.10.0, plus the copies nested under convos-cli and
# content-type-primitives) require GLIBC_2.38+; the unpinned node:24-slim can
# resolve to bookworm (Debian 12, glibc 2.36), where dlopen fails and the napi
# loader masks it as "Cannot find native binding. npm has a bug related to
# optional dependencies..." -> convos adapter degraded(init-error) at runtime.
FROM node:24-trixie-slim

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

# BUILD-TIME ASSERTION: the @xmtp native binding MUST load for this image's
# platform or the build fails — a broken image must never ship. Importing
# @xmtp/node-sdk exercises the top-level node-bindings copy and the one nested
# under content-type-primitives; @xmtp/convos-cli exercises its own nested
# copy. This catches BOTH failure modes behind the napi loader's misleading
# "Cannot find native binding" error: per-platform artifacts dropped by the
# installer (npm/cli#4828 class) and a base image whose glibc is too old.
RUN node --input-type=module -e "await import('@xmtp/node-sdk'); await import('@xmtp/convos-cli'); console.log('xmtp native bindings OK');"

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
