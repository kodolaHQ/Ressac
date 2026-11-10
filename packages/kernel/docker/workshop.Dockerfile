# WebAiOs "workshop" container: the agent works in it, isolated from the Mac.
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# Installed globally (/usr/local), so outside the volume mounted on /home/node.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

USER node
WORKDIR /workspace
