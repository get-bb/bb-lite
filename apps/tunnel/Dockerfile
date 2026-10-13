# The frp tunnel test on Fly: frp's server with the bb gate in front of it.
# Build from the repository root, which also holds the shared contract:
#   docker build -f apps/tunnel/Dockerfile .
# (apps/tunnel/Dockerfile.dockerignore keeps the context to the two sources.)
FROM node:24-bookworm-slim AS build
WORKDIR /build
RUN npm install --no-save esbuild@0.28.0
COPY apps/tunnel/src ./apps/tunnel/src
COPY packages/tunnel-contract/src ./packages/tunnel-contract/src
RUN npx esbuild apps/tunnel/src/main.ts --bundle --platform=node --format=esm \
  --alias:@bb/tunnel-contract=./packages/tunnel-contract/src/index.ts \
  --target=node24 --outfile=gate.mjs

FROM node:24-bookworm-slim
ARG FRP_VERSION=0.71.0
ARG FRP_SHA256=84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL -o /tmp/frp.tar.gz \
    "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
  && echo "${FRP_SHA256}  /tmp/frp.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/frp.tar.gz -C /usr/local/bin --strip-components=1 \
    "frp_${FRP_VERSION}_linux_amd64/frps" \
  && rm /tmp/frp.tar.gz

WORKDIR /app
COPY --from=build /build/gate.mjs ./gate.mjs
USER node
CMD ["node", "gate.mjs"]
