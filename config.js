// config.js
require('dotenv').config();

module.exports = {
    port: Number(process.env.PORT) || 3003,
    openRouterKey: process.env.OPENROUTER_API_KEY || '',
    upstreamTimeout: Number(process.env.UPSTREAM_TIMEOUT_MS) || 60000,
    logLevel: process.env.LOG_LEVEL || 'info',
    logFile: './logs/requests.log'
};
