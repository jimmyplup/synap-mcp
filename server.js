'use strict';

/**
 * Standalone runner for the Synap MCP server — the same routes.js that runs
 * in production behind https://pool.linkrra.com/mcp, mounted on a bare
 * Express app so the server is reviewable and runnable in isolation.
 *
 * In production this router is mounted inside Linkrra's credits gateway and
 * proxies to the live /v1 API on the same process. Run standalone, it
 * forwards to whatever OpenAI-compatible base you point it at.
 */
const express = require('express');
const { createMcpRouter } = require('./routes');

const app = express();
app.use(createMcpRouter());

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Synap MCP server listening on :${port}/mcp`));
