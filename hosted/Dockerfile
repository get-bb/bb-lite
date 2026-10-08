# The image a hosted bb server runs on Fly (docs/hosted.md).
# Build from the repository root: docker build -f hosted/Dockerfile .
FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bubblewrap build-essential ca-certificates curl gh git jq less \
    openssh-client \
    procps python3 ripgrep sudo unzip zip \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash bb \
  && echo "bb ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/bb \
  && corepack enable \
  && npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /opt/bb
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --dir apps/app build

ENV BB_DATA_DIR=/data/bb \
  BB_APP_DIR=/opt/bb/apps/app/dist \
  BB_SERVER_PORT=48886 \
  HOME=/data/home \
  PATH=/opt/bb/apps/cli/bin:$PATH

ENTRYPOINT ["/opt/bb/hosted/entrypoint.sh"]
