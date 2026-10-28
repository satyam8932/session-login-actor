# Base image is pinned to a specific Playwright version (24 = Node 24, 1.64.1 =
# Playwright) so the pre-baked browser always matches the "playwright" dependency
# below. This keeps the image light (no extra browser download) and immune to the
# floating ":24" tag drifting to a Playwright version with a different browser.
FROM apify/actor-node-playwright-chrome:24-1.64.1 AS builder

COPY --chown=myuser:myuser package*.json ./

RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser . ./

RUN npm run build

FROM apify/actor-node-playwright-chrome:24-1.64.1

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --chown=myuser:myuser .actor .actor
COPY --from=builder --chown=myuser:myuser /home/myuser/dist ./dist

CMD ["node", "dist/main.js"]
