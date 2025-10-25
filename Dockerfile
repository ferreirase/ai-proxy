FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies first for better caching
COPY package.json package-lock.json* ./
RUN npm install --only=production --no-audit --no-fund

# Copy source files
COPY server.js openapi.yaml ./

# Default environment
ENV PORT=3003 \
    BODY_LIMIT=2mb \
    UPSTREAM_TIMEOUT_MS=60000 \
    CLIENT_TIMEOUT_MS=15000 \
    STATS_DB_PATH=/app/data/stats.db

# Create data dir for sqlite
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3003

CMD ["node", "server.js"]
