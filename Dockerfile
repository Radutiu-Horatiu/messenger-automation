# Playwright image ships with Chromium + all system deps preinstalled.
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

ENV NODE_ENV=production

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript -> dist/
COPY . .
RUN npm run build

# The browser binaries already exist in the base image, but this is a
# harmless no-op that guarantees the version matches package.json.
RUN npx playwright install chromium

CMD ["npm", "start"]
