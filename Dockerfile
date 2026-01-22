FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies first for better caching
COPY package.json package-lock.json* ./
RUN npm install --only=production --no-audit --no-fund

# Copy source files
COPY server.js config.js system-prompt.js openapi.yaml ./

# Default environment
ARG PORT=3003
ENV PORT=${PORT} \
    UPSTREAM_TIMEOUT_MS=60000 \
    LOG_LEVEL=info

EXPOSE 3003

CMD ["node", "server.js"]
