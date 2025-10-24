// claude-code-ultimate-configurable.js
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3001;
const OPENROUTER_KEY = `${process.env.OPENROUTER_API_KEY}`;
const CONFIG_FILE = path.join(__dirname, "whitelist.json");

// Config padrão
let config = {
  allowedTools: ["Read", "Edit", "Bash"],
  mcpServers: [],
  compactSystemPrompt: true,
  blockTitleGeneration: true,
  blockWarmup: true,
};

// Carregar config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const fileContent = fs.readFileSync(CONFIG_FILE, "utf8");
      config = { ...config, ...JSON.parse(fileContent) };
      console.log(`✅ Loaded config from ${CONFIG_FILE}`);
      console.log(`   Allowed tools: ${config.allowedTools.join(", ")}`);
      console.log(
        `   MCP servers: ${config.mcpServers.length > 0 ? config.mcpServers.join(", ") : "none"}`,
      );
    } else {
      // Criar arquivo de exemplo
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(
          {
            allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"],
            mcpServers: ["filesystem", "github"],
            compactSystemPrompt: true,
            blockTitleGeneration: true,
            blockWarmup: true,
            _comment:
              "Add tool names or MCP server names you want to allow. Restart proxy after changes.",
          },
          null,
          2,
        ),
      );
      console.log(`✅ Created example config at ${CONFIG_FILE}`);
    }
  } catch (err) {
    console.error(`⚠️  Error loading config: ${err.message}`);
  }
}

loadConfig();

// Recarregar config ao receber SIGUSR1
process.on("SIGUSR1", () => {
  console.log("\n🔄 Reloading config...");
  loadConfig();
  console.log("✅ Config reloaded!\n");
});

const MINIMAL_SYSTEM =
  "You are Claude Code, a helpful coding assistant. Provide concise, working code solutions.";

let stats = { blocked: 0, allowed: 0, savedTokens: 0, startTime: Date.now() };

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end("Method Not Allowed");
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    try {
      const payload = JSON.parse(body);
      const originalSize = body.length;
      const originalTokens = Math.floor(originalSize / 4);

      // Extrair user content
      const userMessage = payload.messages?.find((m) => m.role === "user");
      let userContent = "";
      if (userMessage) {
        if (typeof userMessage.content === "string") {
          userContent = userMessage.content;
        } else if (Array.isArray(userMessage.content)) {
          userContent = userMessage.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join(" ");
        }
      }

      // FILTROS CONFIGURÁVEIS
      if (
        config.blockTitleGeneration &&
        (userContent.includes("5-10 word title") ||
          userContent.includes("Please write a"))
      ) {
        stats.blocked++;
        stats.savedTokens += originalTokens;
        console.log(`❌ BLOCKED: Title generation (~${originalTokens} tokens)`);
        return sendMock(res, payload.model, "Coding Session");
      }

      if (config.blockWarmup && userContent.trim() === "Warmup") {
        stats.blocked++;
        stats.savedTokens += originalTokens;
        console.log(`❌ BLOCKED: Warmup (~${originalTokens} tokens)`);
        return sendMock(res, payload.model, "Ready");
      }

      // COMPACTAÇÃO
      let savedTokens = 0;

      // 1. System prompt
      if (
        config.compactSystemPrompt &&
        payload.messages &&
        payload.messages[0]?.role === "system"
      ) {
        const origSize = JSON.stringify(payload.messages[0].content).length;
        payload.messages[0] = { role: "system", content: MINIMAL_SYSTEM };
        savedTokens += Math.floor((origSize - MINIMAL_SYSTEM.length) / 4);
      }

      // 2. Tools WHITELIST
      if (payload.tools && payload.tools.length > 0) {
        const originalToolsSize = JSON.stringify(payload.tools).length;
        const originalToolCount = payload.tools.length;

        // Filtrar tools baseado na whitelist
        payload.tools = payload.tools.filter((tool) => {
          const toolName = tool.function?.name || tool.name;

          // Permitir se está na whitelist de tools
          if (config.allowedTools.includes(toolName)) {
            return true;
          }

          // Permitir se pertence a um MCP server whitelisted
          if (config.mcpServers.length > 0) {
            const toolLower = toolName.toLowerCase();
            return config.mcpServers.some((server) =>
              toolLower.includes(server.toLowerCase()),
            );
          }

          return false;
        });

        // Se removeu muitas tools, compactar as descrições das restantes
        if (payload.tools.length > 0) {
          payload.tools = payload.tools.map((tool) => {
            if (
              tool.function?.description &&
              tool.function.description.length > 200
            ) {
              return {
                ...tool,
                function: {
                  ...tool.function,
                  description: tool.function.description.slice(0, 150) + "...",
                },
              };
            }
            return tool;
          });
        }

        const newToolsSize = JSON.stringify(payload.tools).length;
        savedTokens += Math.floor((originalToolsSize - newToolsSize) / 4);

        console.log(
          `   🔧 Tools: ${originalToolCount} → ${payload.tools.length} (saved ~${Math.floor((originalToolsSize - newToolsSize) / 4)} tokens)`,
        );
      }

      stats.savedTokens += savedTokens;

      const finalSize = JSON.stringify(payload).length;
      const finalTokens = Math.floor(finalSize / 4);
      const reduction = ((1 - finalSize / originalSize) * 100).toFixed(1);

      stats.allowed++;
      console.log(
        `✅ OPTIMIZED: ${originalTokens} → ${finalTokens} tokens (${reduction}% reduction)`,
      );
      printStats();

      // Proxy
      const options = {
        hostname: "openrouter.ai",
        port: 443,
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer":
            req.headers["http-referer"] ||
            "https://github.com/saoudrizwan/claude-code-router",
          "X-Title": "Ultimate Configurable Proxy",
        },
      };

      const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (err) => {
        console.error("❌ Error:", err);
        res.writeHead(500);
        res.end("Error");
      });

      proxyReq.write(JSON.stringify(payload));
      proxyReq.end();
    } catch (err) {
      console.error("❌ Parse error:", err);
      res.writeHead(400);
      res.end("Bad Request");
    }
  });
});

function sendMock(res, model, content) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "blocked-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 2, total_tokens: 2 },
    }),
  );
}

function printStats() {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  console.log(
    `📊 ${stats.blocked} blocked | ${stats.allowed} allowed | ${stats.savedTokens} saved | ${uptime}s\n`,
  );
}

server.listen(PORT, () => {
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   ULTIMATE CONFIGURABLE PROXY                         ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`📝 Config: ${CONFIG_FILE}`);
  console.log(`\n⚙️  Current settings:`);
  console.log(`   Allowed tools: ${config.allowedTools.join(", ")}`);
  console.log(
    `   MCP servers: ${config.mcpServers.length > 0 ? config.mcpServers.join(", ") : "none"}`,
  );
  console.log(`   Compact system prompt: ${config.compactSystemPrompt}`);
  console.log(`   Block title generation: ${config.blockTitleGeneration}`);
  console.log(`   Block warmup: ${config.blockWarmup}`);
  console.log(`\n🔄 To reload config: kill -SIGUSR1 ${process.pid}`);
  console.log(`   Or restart the proxy\n`);
  console.log("Ready! 🚀\n");
});
