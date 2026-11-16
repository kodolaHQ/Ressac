# Ressac "workshop" container: the agent works in it, isolated from the Mac.
# The slim base and the cleaned npm cache keep the image at about 1.4 GB (2.3 GB on the full base).
# Pinned by digest (Dependabot bumps it); a new digest changes the Dockerfile hash, so testers rebuild the image once.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates build-essential python3 iptables \
 && rm -rf /var/lib/apt/lists/*

# Installed globally (/usr/local), so outside the volume mounted on /home/node. Pinned: every tester runs the same
# agents, and « Reconstruire » never picks up a broken or compromised release; a bump changes the hash, so images rebuild.
RUN npm install -g @anthropic-ai/claude-code@2.1.325 @openai/codex@0.169.0 \
 && npm cache clean --force

# Network lock-down: the allowlist proxy runs as its own user, the rules are applied by root at session start.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin ressac-proxy
COPY ressac-network.mjs /opt/ressac/ressac-network.mjs

# Only root-owned (managed) hooks run: a hook the agent writes in a settings or config file it owns is ignored.
RUN mkdir -p /etc/claude-code /etc/codex \
 && echo '{"allowManagedHooksOnly": true}' > /etc/claude-code/managed-settings.json \
 && echo 'allow_managed_hooks_only = true' > /etc/codex/requirements.toml \
 && chmod 644 /etc/claude-code/managed-settings.json /etc/codex/requirements.toml

# npm install scripts off by default (global npmrc, root-owned; ~/.npmrc or a project .npmrc can still override it).
RUN echo 'ignore-scripts=true' > /usr/local/etc/npmrc

USER node
WORKDIR /workspace
