// server.js
// Minimal, stable Express proxy for OpenRouter with healthcheck, timeouts,
// body size limit, error handling, and concise logging. No payload mutation.

require('dotenv').config();
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const pino = require('pino');
const pinoHttp = require('pino-http');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }
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
const STATS_DB_PATH = process.env.STATS_DB_PATH || 'stats.db';

if (!OPENROUTER_API_KEY) {
  logger.error('🚫 [startup] Missing OPENROUTER_API_KEY in environment.');
  process.exit(1);
}

const app = express();

// Stats storage (SQLite) — optional if better-sqlite3 is available
let db, insertStat,
  selectSummaryAll, selectSummarySince,
  selectSummaryByAgentAll, selectSummaryByAgentSince,
  selectAllRows, selectRowsSince,
  selectRowsByAgentAll, selectRowsByAgentSince;
if (Database) {
  try {
    db = new Database(STATS_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent TEXT NOT NULL,
      in_bytes INTEGER NOT NULL,
      est_tokens INTEGER NOT NULL,
      out_bytes INTEGER NOT NULL,
      upstream_status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );`);
    insertStat = db.prepare(`INSERT INTO stats (ts, agent, in_bytes, est_tokens, out_bytes, upstream_status, duration_ms)
                             VALUES (@ts, @agent, @in_bytes, @est_tokens, @out_bytes, @upstream_status, @duration_ms)`);
    selectSummaryAll = db.prepare(`SELECT agent,
        COUNT(*) as requests,
        SUM(in_bytes) as sum_in,
        SUM(out_bytes) as sum_out,
        AVG(duration_ms) as avg_ms
      FROM stats GROUP BY agent`);
    selectSummarySince = db.prepare(`SELECT agent,
        COUNT(*) as requests,
        SUM(in_bytes) as sum_in,
        SUM(out_bytes) as sum_out,
        AVG(duration_ms) as avg_ms
      FROM stats WHERE ts >= ? GROUP BY agent`);
    selectSummaryByAgentAll = db.prepare(`SELECT agent,
        COUNT(*) as requests,
        SUM(in_bytes) as sum_in,
        SUM(out_bytes) as sum_out,
        AVG(duration_ms) as avg_ms
      FROM stats WHERE agent = ? GROUP BY agent`);
    selectSummaryByAgentSince = db.prepare(`SELECT agent,
        COUNT(*) as requests,
        SUM(in_bytes) as sum_in,
        SUM(out_bytes) as sum_out,
        AVG(duration_ms) as avg_ms
      FROM stats WHERE ts >= ? AND agent = ? GROUP BY agent`);
    selectAllRows = db.prepare(`SELECT id, ts, agent, in_bytes, est_tokens, out_bytes, upstream_status, duration_ms FROM stats ORDER BY id ASC`);
    selectRowsSince = db.prepare(`SELECT id, ts, agent, in_bytes, est_tokens, out_bytes, upstream_status, duration_ms FROM stats WHERE ts >= ? ORDER BY id ASC`);
    selectRowsByAgentAll = db.prepare(`SELECT id, ts, agent, in_bytes, est_tokens, out_bytes, upstream_status, duration_ms FROM stats WHERE agent = ? ORDER BY id ASC`);
    selectRowsByAgentSince = db.prepare(`SELECT id, ts, agent, in_bytes, est_tokens, out_bytes, upstream_status, duration_ms FROM stats WHERE ts >= ? AND agent = ? ORDER BY id ASC`);
    logger.info(`🗃️  [stats] DB ready at ${STATS_DB_PATH}`);
  } catch (e) {
    logger.error({ err: e }, '⚠️  [stats] DB init failed');
  }
} else {
  logger.info('ℹ️  [stats] better-sqlite3 not installed; stats persistence disabled');
}

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
    genReqId: (req) => (crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2,8)}`),
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
  } catch (_) {}
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
    const warnCoder   = Number(process.env.WARN_TOKENS_CODER   || 6000);
    const warnTester  = Number(process.env.WARN_TOKENS_TESTER  || 4000);
    const thresholds = { manager: warnManager, coder: warnCoder, tester: warnTester };
    const thresh = thresholds[agent] || warnManager;
    if (estTokens > thresh) {
      req.log.warn(`⚠️  [${req.id}] high input for agent=${agent}: ~${estTokens} tokens (>${thresh})`);
    }
  } catch (_) {}

  const upstreamReq = https.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    let outBytes = 0;
    const tee = new PassThrough();
    tee.on('data', (chunk) => { outBytes += chunk.length; });
    tee.on('end', () => {
      const ms = Date.now() - startUpstream;
      req.log.info(`📊 [${req.id}] agent=${agent} in=${inBytes}B (~${estTokens} tok) out=${outBytes}B upstream=${upstreamRes.statusCode} ${ms}ms`);
      if (insertStat) {
        try {
          insertStat.run({ ts: Date.now(), agent, in_bytes: inBytes, est_tokens: estTokens, out_bytes: outBytes, upstream_status: upstreamRes.statusCode || 0, duration_ms: ms });
        } catch (e) {
          req.log.error({ err: e }, '⚠️  [stats] insert failed');
        }
      }
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

  if (body && body.length) upstreamReq.write(body);
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

// Stats endpoint: optional periodMinutes to limit window
app.get('/stats', (req, res) => {
  try {
    if (!db || !selectSummaryAll) return res.json({ error: 'stats persistence disabled' });
    const mins = req.query && req.query.periodMinutes ? Number(req.query.periodMinutes) : 0;
    const agent = req.query && req.query.agent ? String(req.query.agent).toLowerCase() : '';
    let rows;
    if (mins && mins > 0) {
      const since = Date.now() - mins * 60 * 1000;
      rows = agent ? selectSummaryByAgentSince.all(since, agent) : selectSummarySince.all(since);
    } else {
      rows = agent ? selectSummaryByAgentAll.all(agent) : selectSummaryAll.all();
    }
    res.json({ periodMinutes: mins || null, agent: agent || null, summary: rows });
  } catch (e) {
    logger.error({ err: e }, '⚠️  [stats] query failed');
    res.status(500).json({ error: 'stats query failed' });
  }
});

// Export stats as CSV: GET /stats/export?periodMinutes=60
app.get('/stats/export', (req, res) => {
  try {
    if (!db || !selectAllRows) return res.status(400).json({ error: 'stats persistence disabled' });
    const mins = req.query && req.query.periodMinutes ? Number(req.query.periodMinutes) : 0;
    const agent = req.query && req.query.agent ? String(req.query.agent).toLowerCase() : '';
    let rows;
    if (mins && mins > 0) {
      const since = Date.now() - mins * 60 * 1000;
      rows = agent ? selectRowsByAgentSince.all(since, agent) : selectRowsSince.all(since);
    } else {
      rows = agent ? selectRowsByAgentAll.all(agent) : selectAllRows.all();
    }
    const suffix = [agent || null, mins ? `${mins}m` : null].filter(Boolean).join('_') || 'all';
    const filename = `stats_${suffix}_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // CSV header
    res.write('id,ts_iso,agent,in_bytes,est_tokens,out_bytes,upstream_status,duration_ms\n');
    for (const r of rows) {
      const tsIso = new Date(r.ts).toISOString();
      res.write(`${r.id},${tsIso},${r.agent},${r.in_bytes},${r.est_tokens},${r.out_bytes},${r.upstream_status},${r.duration_ms}\n`);
    }
    res.end();
  } catch (e) {
    logger.error({ err: e }, '⚠️  [stats] export failed');
    res.status(500).json({ error: 'stats export failed' });
  }
});

// Start
app.listen(PORT, () => {
  logger.info('');
  logger.info('🚀 ╔══════════════════════════════════════════╗');
  logger.info('🚀 ║   Minimal Express Proxy (OpenRouter)     ║');
  logger.info('🚀 ╚══════════════════════════════════════════╝');
  logger.info(`🔌 Listening on http://localhost:${PORT}`);
  logger.info(`🧩 Body limit: ${BODY_LIMIT} | ⏱️  Upstream timeout: ${UPSTREAM_TIMEOUT_MS}ms | 💤 Client idle: ${CLIENT_TIMEOUT_MS}ms`);
});
