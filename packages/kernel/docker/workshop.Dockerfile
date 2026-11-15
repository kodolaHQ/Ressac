# Ressac "workshop" container: the agent works in it, isolated from the Mac.
# The slim base and the cleaned npm cache keep the image at about 1.4 GB (2.3 GB on the full base).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates build-essential python3 iptables \
 && rm -rf /var/lib/apt/lists/*

# Installed globally (/usr/local), so outside the volume mounted on /home/node.
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force

# Network lock-down: the allowlist proxy runs as its own user, the rules are applied by root at session start.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin ressac-proxy
COPY ressac-network.mjs /opt/ressac/ressac-network.mjs

USER node
WORKDIR /workspace
