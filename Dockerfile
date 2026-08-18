# Playwright base image matching the pinned playwright version — browsers preinstalled.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "src/server.js"]
