# Conteneur « atelier » de WebAiOs : l'agent y travaille, isolé du Mac.
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# Installé en global (/usr/local), donc hors du volume monté sur /home/node.
RUN npm install -g @anthropic-ai/claude-code

USER node
WORKDIR /workspace
