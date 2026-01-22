require('dotenv').config();
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const pino = require('pino');
const pinoHttp = require('pino-http');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
let swaggerUi, yaml;
try { swaggerUi = require('swagger-ui-express'); } catch (_) { swaggerUi = null; }
try { yaml = require('js-yaml'); } catch (_) { yaml = null; }
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3003;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const BODY_LIMIT = process.env.BODY_LIMIT || '2mb';
const UPSTREAM_TIMEOUT_MS = process.env.UPSTREAM_TIMEOUT_MS ? Number(process.env.UPSTREAM_TIMEOUT_MS) : 60000; // 60s
const CLIENT_TIMEOUT_MS = process.env.CLIENT_TIMEOUT_MS ? Number(process.env.CLIENT_TIMEOUT_MS) : 15000; // 15s idle
const LOG_DIR = process.env.LOG_DIR || 'logs';
const LOG_FILE = path.join(LOG_DIR, 'requests.log');
const PROMPT_LOG = path.join(LOG_DIR, 'system_prompts.txt');
let firstSystemPromptLogged = false;

// Hardcoded system prompt
const CUSTOM_SYSTEM_PROMPT = `You are Claude Code, Anthropic's CLI for software engineering.

CRITICAL SECURITY:
- Assist: Authorized security testing, CTF, defensive security, education
- Refuse: Destructive attacks, DoS, mass targeting, supply chain compromise
- Never generate/guess URLs unless confident they help with programming

BEHAVIOR:
- Execute directly using available tools. Don't just suggest.
- Prefer editing existing files over creating new ones.
- Read files before modifying them.
- When unclear, infer intent and proceed.
- Use tools to discover details vs asking questions.
- Mark todos completed immediately after finishing.

RESPONSE STYLE:
- Short, concise, CLI-appropriate (markdown supported)
- No emojis unless user requests
- No colons before tool calls ("Let me read." not "Let me read:")
- No time estimates ever
- Technical accuracy over validation
- Direct, objective, no superlatives/praise

CODE QUALITY:
- Avoid over-engineering: Only what's requested
- Don't add features/refactoring/improvements not asked
- Don't add error handling for impossible scenarios
- Trust framework internals; validate only at boundaries (user input, external APIs)
- Three similar lines > premature abstraction
- Delete unused code completely (no backwards-compat hacks)
- Comments only where logic isn't self-evident
- Fix security issues immediately (XSS, SQL injection, OWASP top 10)

TOOL USAGE:
- Parallel calls when independent, sequential when dependent
- Never use placeholders/guesses in tool calls
- Specialized tools > bash (read_file vs cat, etc)
- Never use bash echo for communication - output text directly
- For codebase exploration (not needle queries), use Task with subagent_type=Explore

CODE REFERENCES:
Format: file_path:line_number (e.g., src/app.ts:42)

<system-reminder> tags contain useful info. Unlimited context via auto-summarization.`;
logger.info(`📝 [startup] Loaded hardcoded system prompt (${CUSTOM_SYSTEM_PROMPT.length} chars)`);

if (!OPENROUTER_API_KEY) {
  logger.error('🚫 [startup] Missing OPENROUTER_API_KEY in environment.');
  process.exit(1);
}

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logger.info(`📂 [startup] Created logs directory at ${LOG_DIR}`);
  } catch (e) {
    logger.error({ err: e }, '⚠️  [startup] Failed to create logs directory');
  }
}

const app = express();

// Capture raw body so we can forward exactly as received
app.use(express.json({
  limit: BODY_LIMIT,
  verify: (req, _res, buf) => {
    req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
  },
}));

// pino-http integration for Express
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    customLogLevel: function (req, res, err) {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: function (req, res) {
      return `📝 [${req.id}] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode}`;
    },
    customErrorMessage: function (req, res, err) {
      return `🛑 [${req.id}] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} ${err ? err.message : ''}`;
    },
    // avoid noisy auto logs for health if desired
    autoLogging: {
      ignore: (req) => req.url.startsWith('/health'),
    },
  })
);

// Echo X-Request-Id header
app.use((req, res, next) => {
  if (req.id) res.setHeader('X-Request-Id', req.id);
  next();
});

// Healthcheck
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), port: PORT });
});

// OpenAPI (Swagger) docs loaded from openapi.yaml
let openapiSpec = null;
const openapiPath = path.join(__dirname, 'openapi.yaml');
try {
  if (yaml) {
    const raw = fs.readFileSync(openapiPath, 'utf8');
    openapiSpec = yaml.load(raw);
  }
} catch (e) {
  logger.error({ err: e }, '⚠️  Failed to load openapi.yaml');
}

app.get('/openapi.json', (_req, res) => {
  if (!openapiSpec) return res.status(503).json({ error: 'openapi spec not available' });
  res.json(openapiSpec);
});
if (swaggerUi && openapiSpec) {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
  logger.info('📚 Swagger UI available at /docs');
} else if (!swaggerUi) {
  logger.info('ℹ️  Swagger UI not installed. Install with: npm i swagger-ui-express');
}

// Helper to log to file
function logRequestToFile(data) {
  // Write first system prompt once
  if (!firstSystemPromptLogged) {
    try {
      const requestBody = JSON.parse(data.request_body);
      const systemMessage = requestBody.messages?.find(m => m.role === 'system');
      if (systemMessage && systemMessage.content) {
        let content = systemMessage.content;
        if (Array.isArray(content)) {
          content = content.map(c => c.text).join('\n');
        }
        fs.appendFile(PROMPT_LOG, content + '\n', (err) => {
          if (err) logger.error({ err }, '⚠️  [prompt-log] write failed');
          else {
            logger.info(`📝 [prompt-log] First system prompt written to ${PROMPT_LOG}`);
            firstSystemPromptLogged = true;
          }
        });
      }
    } catch (e) {
      logger.error({ err: e }, '⚠️  [prompt-log] Error parsing request body for system prompt');
    }
  }

  // Log request data
  const line = JSON.stringify(data) + '\n';
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) logger.error({ err }, '⚠️  [file-log] write failed');
  });
}

// Core proxy route (no payload mutation)
function proxyHandler(req, res) {
  // Apply client connection timeout (idle)
  req.setTimeout(CLIENT_TIMEOUT_MS, () => {
    res.status(408).json({ error: 'Client timeout', detail: `Idle > ${CLIENT_TIMEOUT_MS}ms` });
  });

  const body = typeof req.rawBody === 'string' ? req.rawBody : '';
  const inBytes = Buffer.byteLength(body || '', 'utf8');
  const estTokens = Math.floor(inBytes / 4);
  let agent = 'manager';
  try {
    const urlStr = req.originalUrl || req.url;
    const qIndex = urlStr.indexOf('?');
    if (qIndex >= 0) {
      const params = new URLSearchParams(urlStr.slice(qIndex));
      const a = String(params.get('agent') || '').toLowerCase();
      if (a === 'coder' || a === 'tester' || a === 'manager') agent = a || 'manager';
    }
  } catch (_) { }

  let modifiedBody = body;
  let promptReplaced = false;
  if (CUSTOM_SYSTEM_PROMPT && body && body.length) {
    try {
      const requestData = JSON.parse(body);
      if (requestData.messages && Array.isArray(requestData.messages)) {
        const systemMsgIndex = requestData.messages.findIndex(m => m.role === 'system');
        if (systemMsgIndex >= 0) {
          requestData.messages[systemMsgIndex].content = CUSTOM_SYSTEM_PROMPT;
          modifiedBody = JSON.stringify(requestData);
          promptReplaced = true;
          req.log.info(`🔄 [${req.id}] Replaced system prompt with custom prompt`);
        }
      }
    } catch (e) {
      req.log.warn({ err: e }, `⚠️  [${req.id}] Failed to replace system prompt, using original body`);
    }
  }

  const options = {
    hostname: 'openrouter.ai',
    port: 443,
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept': req.headers['accept'] || '*/*',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': req.headers['http-referer'] || req.headers['referer'] || '',
      'X-Title': req.headers['x-title'] || 'Express Proxy',
      'X-Request-Id': req.id,
    },
  };

  const startUpstream = Date.now();
  // Soft warnings for large inputs (no blocking, no mutation)
  try {
    const warnManager = Number(process.env.WARN_TOKENS_MANAGER || 2000);
    const warnCoder = Number(process.env.WARN_TOKENS_CODER || 6000);
    const warnTester = Number(process.env.WARN_TOKENS_TESTER || 4000);
    const thresholds = { manager: warnManager, coder: warnCoder, tester: warnTester };
    const thresh = thresholds[agent] || warnManager;
    if (estTokens > thresh) {
      req.log.warn(`⚠️  [${req.id}] high input for agent=${agent}: ~${estTokens} tokens (>${thresh})`);
    }
  } catch (_) { }

  const upstreamReq = https.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    let outBytes = 0;
    const chunks = [];
    const tee = new PassThrough();
    tee.on('data', (chunk) => {
      outBytes += chunk.length;
      chunks.push(chunk);
    });
    tee.on('end', () => {
      const ms = Date.now() - startUpstream;
      const responseBody = Buffer.concat(chunks).toString('utf8');
      req.log.info(`📊 [${req.id}] agent=${agent} in=${inBytes}B (~${estTokens} tok) out=${outBytes}B upstream=${upstreamRes.statusCode} ${ms}ms`);

      // Log to file instead of SQLite
      logRequestToFile({
        ts: Date.now(),
        ts_iso: new Date().toISOString(),
        reqId: req.id,
        agent,
        in_bytes: inBytes,
        est_tokens: estTokens,
        out_bytes: outBytes,
        upstream_status: upstreamRes.statusCode || 0,
        duration_ms: ms,
        request_body: modifiedBody,
        response_body: responseBody,
        prompt_replaced: promptReplaced
      });
    });
    upstreamRes.pipe(tee).pipe(res);
  });

  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error(`⏳ Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`));
  });

  upstreamReq.on('error', (err) => {
    logger.error({ err }, '🛑 [upstream]');
    if (!res.headersSent) res.status(502);
    res.type('application/json').end(JSON.stringify({ error: 'Bad Gateway', detail: String(err && err.message ? err.message : err) }));
  });

  if (modifiedBody && modifiedBody.length) upstreamReq.write(modifiedBody);
  upstreamReq.end();
}


// Compatibility routes: accept multiple paths used by different clients
app.post('/', proxyHandler);
app.post('/v1/chat/completions', proxyHandler);
app.post('/api/v1/chat/completions', proxyHandler);

// 404 handler (explicit)
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error({ err }, '[error]');
  if (!res.headersSent) res.status(500);
  res.json({ error: 'Internal Server Error' });
});

// Start
app.listen(PORT, () => {
  logger.info('');
  logger.info('🚀 ╔══════════════════════════════════════════╗');
  logger.info('🚀 ║   Minimal Express Proxy (OpenRouter)     ║');
  logger.info('🚀 ╚══════════════════════════════════════════╝');
  logger.info(`🔌 Listening on http://localhost:${PORT}`);
  logger.info(`🧩 Body limit: ${BODY_LIMIT} | ⏱️  Upstream timeout: ${UPSTREAM_TIMEOUT_MS}ms | 💤 Client idle: ${CLIENT_TIMEOUT_MS}ms`);
  logger.info(`📝 Logging requests to ${LOG_FILE}`);
});
