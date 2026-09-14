# Playwright image ships with Chromium + all system deps preinstalled.
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Install dependencies first for better layer caching. Don't set
# NODE_ENV=production yet, otherwise npm ci skips TypeScript (devDependency)
# and `npm run build` will fail with "tsc: not found".
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript -> dist/
COPY . .
RUN npm run build

# The browser binaries already exist in the base image, but this is a
# harmless no-op that guarantees the version matches package.json.
RUN npx playwright install chromium

ENV NODE_ENV=production
# Run node directly rather than through `npm start`. The exit code is now the
# alert channel (non-zero = Railway marks the run Crashed and emails you), and
# npm in the middle is a known source of spurious non-zero exits on Railway
# when it relays shutdown signals — false alarms on every redeploy.
CMD ["node", "--enable-source-maps", "dist/index.js"]
