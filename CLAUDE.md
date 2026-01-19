# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### 1. Build System
```bash
npm run build          # Compile TypeScript to JavaScript (tsc)
npm run dev            # Development mode with auto-reload (nodemon)
npm start              # Start production server (node dist/index.js)
```

### 2. Code Quality
```bash
npm run lint           # Run ESLint on TypeScript files (eslint src/**/*.ts)
npm run format         # Format code with Prettier (prettier --write src/**/*.ts)
```

### 3. Proxy Runtime Commands
```bash
node index.js                              # Run legacy proxy directly
kill -SIGUSR1 $(pgrep -f claude-code-ultimate)  # Hot-reload config without restart
```

## High-Level Code Architecture and Structure

This repository implements a token optimization proxy for Claude Code Router that reduces API token consumption by 96% through intelligent payload filtering and optimization.

The main components are:

- `src/index.ts`: Server entry point (TypeScript)
- `src/app.ts`: Express app initialization
- `index.js`: Main proxy implementation (Node.js)
- `whitelist.json`: Configuration for allowed tools/MCP servers

The proxy configuration is stored in `whitelist.json`, which defines the allowed tools and MCP servers.

See the Architecture section of the README for a detailed diagram of the data flow.
