require('dotenv').config();
const fastify = require('fastify');
const https = require('https');

const config = require('./config.js');
const CUSTOM_SYSTEM_PROMPT = require('./system-prompt.js');

const app = fastify({
  logger: { level: config.logLevel }
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10
});

// ============================================================================
// CONTEXTUAL VALIDATION ENGINE
// ============================================================================

const INTERNAL_OPERATION_PATTERNS = {
  gitHistory: {
    systemIndicators: [
      /you\s+are\s+(?:an\s+)?expert\s+at\s+analyzing\s+git\s+history/i,
      /analyze.*git.*(?:commit|history|changes)/i,
      /identify.*frequently\s+modified/i
    ],
    userIndicators: [
      /^files?\s+modified\s+by\s+user:\s*$/i,  // Exato: "Files modified by user:" sozinho
      /^files?\s+modified\s+by\s+user:\s*\n\s*\d+/im  // Seguido de listagem numérica
    ]
  },

  topicDetection: {
    systemIndicators: [
      /analyze.*(?:if|whether).*new\s+(?:conversation\s+)?topic/i,
      /\bisnewtopic\b/i,
      /extract\s+(?:a\s+)?(?:\d+-\d+\s+)?word\s+title.*conversation/i
    ],
    userIndicators: [
      /^[\w\s]{1,15}$/  // Mensagens muito curtas (1-15 chars)
    ]
  }
};

function extractContentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text')
      .map(item => item.text || '')
      .join(' ');
  }
  return JSON.stringify(content);
}

function validateRequest(data) {
  try {
    const systemMsg = data.messages?.find(m => m.role === 'system');
    const userMsg = data.messages?.find(m => m.role === 'user');

    if (!systemMsg || !userMsg) {
      return { decision: 'ALLOW', reason: 'missing-messages' };
    }

    const systemText = extractContentText(systemMsg.content);
    const userText = extractContentText(userMsg.content);
    const cleanUserText = userText
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    // ==========================================
    // REGRA 1: GIT HISTORY (combinação obrigatória)
    // ==========================================
    const hasGitSystemPrompt = INTERNAL_OPERATION_PATTERNS.gitHistory.systemIndicators
      .some(pattern => pattern.test(systemText));

    const hasGitUserPattern = INTERNAL_OPERATION_PATTERNS.gitHistory.userIndicators
      .some(pattern => pattern.test(cleanUserText));

    // Só bloqueia se AMBOS estiverem presentes
    if (hasGitSystemPrompt && hasGitUserPattern) {
      return { decision: 'BLOCK', reason: 'git-history-operation' };
    }

    // ==========================================
    // REGRA 2: TOPIC DETECTION (combinação obrigatória)
    // ==========================================
    const hasTopicSystemPrompt = INTERNAL_OPERATION_PATTERNS.topicDetection.systemIndicators
      .some(pattern => pattern.test(systemText));

    const hasTopicUserPattern = INTERNAL_OPERATION_PATTERNS.topicDetection.userIndicators
      .some(pattern => pattern.test(cleanUserText));

    // Só bloqueia se system indica topic detection E user é muito curto (indicador de user message irrelevante)
    if (hasTopicSystemPrompt && (hasTopicUserPattern || cleanUserText.length < 20)) {
      return { decision: 'BLOCK', reason: 'topic-detection-operation' };
    }

    // ==========================================
    // REGRA 3: EMPTY/WHITESPACE ONLY (sempre bloqueia)
    // ==========================================
    if (/^[\s\n\r]*$/.test(cleanUserText)) {
      return { decision: 'BLOCK', reason: 'empty-user-message' };
    }

    // ==========================================
    // REGRA 4: APENAS TAGS SYSTEM (sempre bloqueia)
    // ==========================================
    if (/^<[^>]+>[\s\n\r]*<\/[^>]+>$/.test(cleanUserText)) {
      return { decision: 'BLOCK', reason: 'system-tags-only' };
    }

    // ==========================================
    // REGRA 5: FILE LISTING FORMAT (estrutura específica)
    // ==========================================
    // Exemplo: "     5 package.json\n     3 server.js"
    const isFileListingFormat = /^\s*\d+\s+[\w\/\.\-]+\.[\w]+(\s*\n\s*\d+\s+[\w\/\.\-]+\.[\w]+)*\s*$/m.test(cleanUserText);

    if (isFileListingFormat && cleanUserText.split('\n').length >= 2) {
      return { decision: 'BLOCK', reason: 'file-listing-format' };
    }

    return { decision: 'ALLOW', reason: 'valid-request' };

  } catch (e) {
    app.log.error({ err: e }, 'Validation error');
    return { decision: 'ALLOW', reason: 'parse-error' };
  }
}

// FAKE RESPONSE GENERATOR
function generateFakeResponse(reason, body) {
  const baseResponse = {
    id: `blocked-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `blocked-${reason}`,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'OK' },
      finish_reason: 'stop'
    }]
  };

  try {
    const data = JSON.parse(body);

    // Customize response based on reason if needed
    if (reason === 'git-history-operation') {
      baseResponse.choices[0].message.content = 'package.json\nserver.js\nREADME.md';
    } else if (reason === 'topic-detection-operation') {
      baseResponse.choices[0].message.content = '{"isNewTopic": false, "title": null}';
    }

    if (data.stream === true) {
      return {
        ...baseResponse,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: 'stop'
        }]
      };
    }
  } catch (e) { }

  return baseResponse;
}

// ============================================================================
// SYSTEM PROMPT REPLACEMENT
// ============================================================================

const SYSTEM_MESSAGE = Object.freeze({
  role: 'system',
  content: CUSTOM_SYSTEM_PROMPT
});

function replaceSystemPrompt(body) {
  if (!body) return { body, replaced: false };

  try {
    const data = JSON.parse(body);
    const idx = data.messages?.findIndex(m => m.role === 'system');

    if (idx >= 0) {
      data.messages[idx] = SYSTEM_MESSAGE;
      return { body: JSON.stringify(data), replaced: true };
    }
  } catch (e) { }

  return { body, replaced: false };
}

// ============================================================================
// LOGGING
// ============================================================================

let requestCount = 0;
let blockedCount = 0;
let forwardedCount = 0;

// ============================================================================
// ROUTES
// ============================================================================

app.get('/health', async () => ({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  stats: {
    total: requestCount,
    blocked: blockedCount,
    forwarded: forwardedCount
  }
}));

async function proxyHandler(request, reply) {
  requestCount++;

  const originalBody = request.body ? JSON.stringify(request.body) : '';
  const tokens = Math.floor(originalBody.length / 4);



  // 🛡️ LAYER 1: CONTEXTUAL REGEX VALIDATION
  try {
    const data = JSON.parse(originalBody);
    const { decision, reason } = validateRequest(data);

    if (decision === 'BLOCK') {
      blockedCount++;
      request.log.warn(`🚫 BLOCKED [${reason}] - ${tokens} tokens saved`);



      const fakeResponse = generateFakeResponse(reason, originalBody);
      return reply.code(200).send(fakeResponse);
    }

  } catch (e) {
    request.log.error({ err: e }, `Parse error, forwarding (Fail-Open)`);
  }

  // ALLOW / FORWARDING
  forwardedCount++;
  request.log.info(`✅ FORWARDING - ${tokens} tokens`);

  const { body: modifiedBody, replaced } = replaceSystemPrompt(originalBody);
  const inBytes = Buffer.byteLength(modifiedBody, 'utf8');

  // Check streaming for proper headers
  let isStreaming = false;
  try {
    const data = JSON.parse(modifiedBody);
    isStreaming = data.stream === true;
  } catch (e) { }

  const options = {
    hostname: 'openrouter.ai',
    port: 443,
    path: '/api/v1/chat/completions',
    method: 'POST',
    agent: httpsAgent,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': inBytes,
      'Authorization': `Bearer ${config.openRouterKey}`,
      'X-Request-Id': request.id,
      ...(isStreaming ? { 'Accept': 'text/event-stream' } : {})
    },
    timeout: config.upstreamTimeout
  };

  return new Promise((resolve, reject) => {
    const upstreamReq = https.request(options, (upstreamRes) => {
      // Stream chunks immediately
      if (isStreaming) {
        reply.raw.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      }

      const chunks = [];

      upstreamRes.on('data', chunk => {
        chunks.push(chunk);
        if (isStreaming) reply.raw.write(chunk);
      });

      upstreamRes.on('end', () => {
        if (isStreaming) {
          reply.raw.end();
        } else {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          reply.code(upstreamRes.statusCode).headers(upstreamRes.headers).send(responseBody);
        }

        const outBytes = Buffer.concat(chunks).length;
        request.log.info(`   → Response: ${outBytes} bytes, Status: ${upstreamRes.statusCode}`);
        resolve();
      });
    });

    upstreamReq.on('error', err => {
      request.log.error({ err }, '❌ Upstream error');
      if (!reply.sent) {
        reply.code(502).send({ error: 'Bad Gateway' });
      }
      reject(err);
    });

    upstreamReq.write(modifiedBody);
    upstreamReq.end();
  });
}

// ==========================================
// ROUTES & START
// ==========================================

app.post('/', proxyHandler);
app.post('/v1/chat/completions', proxyHandler);
app.post('/api/v1/chat/completions', proxyHandler);

async function start() {
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info('');
    app.log.info('🚀 ═══════════════════════════════════════════════════');
    app.log.info('🚀   PROXY COM CONTEXTUAL VALIDATION (RESTORED)');
    app.log.info('🚀 ═══════════════════════════════════════════════════');
    app.log.info(`🔌 Port: ${config.port}`);
    app.log.info('🛡️  Mode: CONTEXTUAL REGEX (No False Positives)');
    app.log.info('');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
