# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

This repository uses a token optimization proxy for Claude Code Router. To start the proxy, use the following command:

```bash
node claude-code-ultimate-configurable.js
```

To configure Claude Code to use the proxy, modify the `~/.config/claude-code-router/config.json` file and set `api_base_url` to `http://localhost:3001`.

To reload the proxy configuration without restarting, use the following command:

```bash
kill -SIGUSR1 $(pgrep -f claude-code-ultimate)
```

## High-Level Code Architecture and Structure

This repository implements a token optimization proxy that sits between Claude Code and the OpenRouter API. It reduces token consumption by filtering unnecessary payload bloat. The core optimizations include:

-   Blocking title generation spam
-   Compacting the system prompt
-   Whitelisting essential tools

The main component is `claude-code-ultimate-configurable.js`, which implements the proxy logic. The proxy configuration is stored in `mcp-whitelist.json`, which defines the allowed tools, MCP servers, and other settings.

See the Architecture section of the README for a detailed diagram of the data flow.
