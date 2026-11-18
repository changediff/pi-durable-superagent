# pi-durable-superagent — hardened container image
# Same base and tooling as the pi-agent image it replaces; the difference is the
# entrypoint: this image runs the super-agent runtime instead of ws-durable.mjs.
FROM node:22-trixie-slim

# Workers need bash/git/curl; tini reaps the node process cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash git ca-certificates curl openssh-client tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /workspace/.superagent /work \
    && chown -R 1001:1001 /app /workspace /work

USER 1001:1001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
