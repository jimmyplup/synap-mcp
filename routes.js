'use strict';

/**
 * @fileoverview Minimal MCP (Model Context Protocol) server for Synap.
 *
 * Hand-rolled Streamable HTTP transport (spec 2025-06-18) — a single POST
 * /mcp route speaking JSON-RPC 2.0. No @modelcontextprotocol/sdk dependency:
 * this repo has none today, and the transport this app needs (one request in,
 * one JSON response out, no server-initiated stream) is a thin enough layer
 * over Express that adding a package for it would be the heavier choice.
 *
 * The point of this endpoint is distribution, not new capability: it exposes
 * the same /v1/chat/completions and /v1/models this server already serves
 * (v1.1 adds get-model and estimate-cost, both computed from /v1/models),
 * so any MCP-aware agent (Claude Desktop, an MCP registry client, etc.) can
 * call Synap without a bespoke integration. Auth is unchanged — the caller's
 * Synap API key goes in the normal `Authorization: Bearer <key>` header on
 * the POST to /mcp, exactly as it would on a direct call to
 * /v1/chat/completions, and this router forwards that header untouched. No
 * key is read, stored or generated here.
 */

const express = require('express');

const PROTOCOL_VERSION = '2025-06-18';

function selfBase(req) {
  const port = req.app.locals.selfPort || process.env.GATEWAY_PORT || 8080;
  return `http://127.0.0.1:${port}`;
}

const SERVER_VERSION = '1.2.0';

// Protocol revisions this server can speak. It uses no feature that differs
// between them (tools only, plain JSON responses), so it answers in whichever
// one the client asked for and falls back to the newest it knows.
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/* T-960, 2026-10-16: MCP 2026-07-28 (the current revision) is stateless — no
 * `initialize` handshake. Every request carries its version in
 * params._meta["io.modelcontextprotocol/protocolVersion"], mirrored in the
 * MCP-Protocol-Version header; servers MUST answer `server/discover`, every
 * result carries `resultType`, and list results carry `ttlMs` + `cacheScope`.
 * Read from https://modelcontextprotocol.io/specification/2026-07-28/changelog
 * and the published schema.json, 2026-10-16.
 *
 * This server is "dual-era" in the spec's own terms (lifecycle, Backward
 * Compatibility): a request that declares a modern version gets modern
 * semantics; anything else — an `initialize`, or a request with no `_meta`
 * version — gets exactly the legacy behaviour it had before. */
const MODERN_PROTOCOLS = ['2026-07-28'];
const ALL_PROTOCOLS = [...MODERN_PROTOCOLS, ...SUPPORTED_PROTOCOLS];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
// tools/list is the same for every caller (no per-key tools), so a shared
// cache may hold it; an hour matches the A2A card's Cache-Control.
const LIST_TTL_MS = 3600 * 1000;
const SERVER_INFO = { name: 'synap', title: 'Synap by Linkrra', version: SERVER_VERSION, websiteUrl: 'https://synap.linkrra.com' };

const INSTRUCTIONS =
  "Synap is Linkrra's OpenAI-compatible inference API for open models (https://synap.linkrra.com). " +
  'synap_list_models, synap_get_model and synap_estimate_cost are free, read-only and need no key — use them to pick a model and price a job. ' +
  'synap_chat_completion runs a model and bills the Synap API key sent as the Authorization: Bearer header on this MCP connection; ' +
  "without a key it returns an error and spends nothing. Use model \"synap-v1\" to let Synap route to the cheapest model that can do the job.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'synap_chat_completion',
    title: 'Run a chat completion on Synap',
    description:
      "Send a conversation to a model on Synap, Linkrra's OpenAI-compatible inference API, and get the model's reply. " +
      'Use this when you need text generated, code written or a question answered by one of the open models Synap serves. ' +
      'This is the only tool here that costs money: it bills prompt and completion tokens to the Synap API key supplied as the ' +
      'Authorization: Bearer header on the MCP connection. With no key it returns an error and nothing is spent; ' +
      'a key with no balance returns insufficient_credits. Call synap_estimate_cost first if the price matters. ' +
      'Returns the standard OpenAI chat.completion JSON (choices[0].message.content holds the reply, usage holds token counts). ' +
      'The call is not streamed and keeps no memory between calls — send the full message history each time.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description:
            'Model id exactly as returned by synap_list_models, e.g. "qwen3-coder-30b". ' +
            'Use "synap-v1" to let Synap pick the cheapest model that can handle the request.',
        },
        messages: {
          type: 'array',
          description: 'The conversation so far, oldest first. The last message is normally the user turn to answer.',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['system', 'user', 'assistant'],
                description: 'Who wrote the message: system (instructions), user, or assistant (an earlier model reply).',
              },
              content: { type: 'string', description: 'The message text.' },
            },
            required: ['role', 'content'],
          },
        },
        temperature: {
          type: 'number',
          minimum: 0,
          maximum: 2,
          description: 'Sampling randomness, 0 to 2. Lower is more deterministic. Omit to use the model default.',
        },
        max_tokens: {
          type: 'integer',
          minimum: 1,
          description: 'Upper limit on tokens generated in the reply. Omit to use the model default; lower it to cap cost.',
        },
      },
      required: ['model', 'messages'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'synap_list_models',
    title: 'List Synap models and prices',
    description:
      'List the models Synap serves right now, each with its price per million tokens, context window and what it is good at. ' +
      'Use this to choose a model id before calling synap_chat_completion, or to compare prices. ' +
      'Free, read-only, no API key needed, and safe to call repeatedly; the list is live, so models can appear or go between calls. ' +
      'Returns {"object":"list","count":N,"data":[{id,name,capability,tier,context_tokens,max_output_tokens,pricing,data_policy}]}; ' +
      'pricing is USD per million prompt and completion tokens and is absent for the auto-routing ids ("synap-v1"), which bill at the price of the model they route to. ' +
      'For every field of one model use synap_get_model.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional case-insensitive filter matched against model id, name and capability, e.g. "coder", "qwen" or "vision". Omit to list everything.',
        },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'synap_get_model',
    title: 'Get one Synap model in full',
    description:
      'Return the complete catalogue record for one Synap model: pricing, context and output limits, supported parameters, quantisation, data-retention policy and readiness. ' +
      'Use this after synap_list_models when you need details the summary leaves out. ' +
      'Free, read-only and needs no API key. Returns the raw model object, or an error naming the id if Synap does not serve it.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id exactly as returned by synap_list_models.' },
      },
      required: ['model'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'synap_estimate_cost',
    title: 'Estimate the cost of a Synap call',
    description:
      'Work out what a chat completion would cost on Synap from token counts, using the live price list. ' +
      'Use this before synap_chat_completion when budget matters, or to compare models for a job. ' +
      'Free, read-only, needs no API key and runs no model. ' +
      'Returns {model, prompt_tokens, completion_tokens, prompt_usd, completion_usd, total_usd, pricing}. ' +
      'It is an estimate: the real charge uses the token counts the model reports afterwards. ' +
      'Auto-routing ids such as "synap-v1" have no fixed price and return an error saying so.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id exactly as returned by synap_list_models.' },
        prompt_tokens: { type: 'integer', minimum: 0, description: 'Tokens you will send (system + conversation). Roughly 4 characters of English per token.' },
        completion_tokens: { type: 'integer', minimum: 0, description: 'Tokens you expect back. Use your max_tokens for a worst case. Defaults to 0.' },
      },
      required: ['model', 'prompt_tokens'],
    },
    annotations: READ_ONLY,
  },
];

function errBody(message) {
  return JSON.stringify({ error: { message } });
}

async function fetchCatalogue(req) {
  const auth = req.headers.authorization;
  const r = await fetch(`${selfBase(req)}/v1/models`, { headers: auth ? { Authorization: auth } : {} });
  const text = await r.text();
  if (!r.ok) return { status: r.status, body: text };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { status: 502, body: errBody('Synap returned a model list that is not valid JSON.') };
  }
  return { status: 200, models: Array.isArray(parsed.data) ? parsed.data : [] };
}

function limitOf(modalities, key) {
  if (!Array.isArray(modalities)) return undefined;
  for (const m of modalities) {
    const v = key === 'in' ? m && m.supported_inputs && m.supported_inputs.max_context_length : m && m.max_length;
    if (v && typeof v.value === 'number') return v.value;
  }
  return undefined;
}

function summarise(m) {
  const out = { id: m.id };
  if (m.name) out.name = m.name;
  if (m.capability) out.capability = m.capability;
  if (m.tier) out.tier = m.tier;
  const ctx = limitOf(m.input_modalities, 'in');
  if (ctx !== undefined) out.context_tokens = ctx;
  const max = limitOf(m.output_modalities, 'out');
  if (max !== undefined) out.max_output_tokens = max;
  if (m.pricing) out.pricing = m.pricing;
  if (m.routing) out.routing = m.routing;
  if (m.data_policy) out.data_policy = m.data_policy;
  return out;
}

async function callTool(req, name, args) {
  const base = selfBase(req);
  const auth = req.headers.authorization;

  if (name === 'synap_list_models') {
    const cat = await fetchCatalogue(req);
    if (!cat.models) return cat;
    const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const data = cat.models
      .filter((m) => !q || [m.id, m.name, m.capability].some((f) => typeof f === 'string' && f.toLowerCase().includes(q)))
      .map(summarise);
    return { status: 200, body: JSON.stringify({ object: 'list', count: data.length, data }) };
  }

  if (name === 'synap_get_model' || name === 'synap_estimate_cost') {
    if (typeof args.model !== 'string' || !args.model) return { status: 400, body: errBody('"model" is required.') };
    const cat = await fetchCatalogue(req);
    if (!cat.models) return cat;
    const m = cat.models.find((x) => x.id === args.model);
    if (!m) return { status: 404, body: errBody(`Synap does not serve a model with id "${args.model}". Call synap_list_models for the current ids.`) };
    if (name === 'synap_get_model') return { status: 200, body: JSON.stringify(m) };

    const pIn = Number(args.prompt_tokens);
    const pOut = args.completion_tokens == null ? 0 : Number(args.completion_tokens);
    if (!Number.isFinite(pIn) || pIn < 0 || !Number.isFinite(pOut) || pOut < 0) {
      return { status: 400, body: errBody('"prompt_tokens" and "completion_tokens" must be non-negative numbers.') };
    }
    const pr = m.pricing;
    if (!pr || typeof pr.prompt_per_million !== 'number' || typeof pr.completion_per_million !== 'number') {
      return {
        status: 422,
        body: errBody(`"${m.id}" has no fixed price${m.routing ? ' — it routes to another model and bills at that model\'s price' : ''}. Estimate against a specific model instead.`),
      };
    }
    const promptUsd = (pIn * pr.prompt_per_million) / 1e6;
    const completionUsd = (pOut * pr.completion_per_million) / 1e6;
    const round = (n) => Number(n.toFixed(8));
    return {
      status: 200,
      body: JSON.stringify({
        model: m.id,
        prompt_tokens: pIn,
        completion_tokens: pOut,
        prompt_usd: round(promptUsd),
        completion_usd: round(completionUsd),
        total_usd: round(promptUsd + completionUsd),
        pricing: pr,
        note: 'Estimate from the live price list; the actual charge uses the token counts the model reports.',
      }),
    };
  }

  if (name === 'synap_chat_completion') {
    if (!auth) {
      return {
        status: 401,
        body: JSON.stringify({
          error: { message: 'Missing Authorization header — pass your Synap API key as a Bearer token on the MCP request. Get a key at https://synap.linkrra.com.' },
        }),
      };
    }
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        stream: false,
        ...(args.temperature != null ? { temperature: args.temperature } : {}),
        ...(args.max_tokens != null ? { max_tokens: args.max_tokens } : {}),
      }),
    });
    return { status: r.status, body: await r.text() };
  }

  return null;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** The protocol version a request declares in its _meta, or undefined (legacy). */
function declaredVersion(msg) {
  const meta = msg && msg.params && msg.params._meta;
  const v = meta && meta[META_VERSION];
  return typeof v === 'string' ? v : undefined;
}

/** Decode the spec's Base64 sentinel (`=?base64?...?=`) used for non-ASCII header values. */
function decodeHeaderValue(v) {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

/**
 * Header-body validation for a modern request (streamable-http, Server
 * Validation). Returns an error message, or null when the headers agree.
 */
function headerMismatch(req, msg, version) {
  const hv = req.get('mcp-protocol-version');
  if (!hv) return 'Missing required header: MCP-Protocol-Version';
  if (hv !== version) return `Header mismatch: MCP-Protocol-Version header value '${hv}' does not match body value '${version}'`;
  const hm = req.get('mcp-method');
  if (!hm) return 'Missing required header: Mcp-Method';
  if (hm !== msg.method) return `Header mismatch: Mcp-Method header value '${hm}' does not match body value '${msg.method}'`;
  if (msg.method === 'tools/call') {
    const raw = req.get('mcp-name');
    if (!raw) return 'Missing required header: Mcp-Name';
    const name = decodeHeaderValue(raw);
    const bodyName = msg.params && msg.params.name;
    if (name !== bodyName) return `Header mismatch: Mcp-Name header value '${name}' does not match body value '${bodyName}'`;
  }
  return null;
}

function modernResult(id, result) {
  return rpcResult(id, { ...result, resultType: 'complete', _meta: { [META_SERVER_INFO]: SERVER_INFO } });
}

/** Run one tool call and shape the MCP result (shared by both eras). */
async function toolCallResult(req, params) {
  const { name, arguments: args } = params || {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  const result = await callTool(req, name, args || {});
  return { content: [{ type: 'text', text: result.body }], isError: result.status >= 400 };
}

/**
 * MCP 2026-07-28 request handling. Called only for a request that declared a
 * version in _meta.
 */
async function handleModern(req, res, msg, version) {
  if (!MODERN_PROTOCOLS.includes(version)) {
    return res.status(400).json(rpcError(msg.id, -32022, `Unsupported protocol version: ${version}`,
      { requested: version, supported: ALL_PROTOCOLS }));
  }
  const mismatch = headerMismatch(req, msg, version);
  if (mismatch) return res.status(400).json(rpcError(msg.id, -32020, mismatch));

  switch (msg.method) {
    case 'server/discover':
      return res.json(modernResult(msg.id, {
        supportedVersions: ALL_PROTOCOLS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ttlMs: LIST_TTL_MS,
        cacheScope: 'public',
      }));
    case 'tools/list':
      return res.json(modernResult(msg.id, { tools: TOOLS, ttlMs: LIST_TTL_MS, cacheScope: 'public' }));
    case 'tools/call': {
      const out = await toolCallResult(req, msg.params);
      if (!out) return res.json(rpcError(msg.id, -32602, `Unknown tool: ${msg.params && msg.params.name}`));
      return res.json(modernResult(msg.id, out));
    }
    default:
      // initialize and ping no longer exist in this revision.
      return res.status(404).json(rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
  }
}

/**
 * @returns {import('express').Router}
 */
function createMcpRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  // No server-initiated SSE stream in this minimal implementation — per spec
  // section 5.3 of the Streamable HTTP transport, a 405 here is a valid way
  // to say "this server does not offer a GET stream at this endpoint".
  router.get('/mcp', (req, res) => res.sendStatus(405));
  // Stateless server (no Mcp-Session-Id issued), so there is no session to
  // terminate; 405 is the documented response for a server that does not
  // support explicit session termination.
  router.delete('/mcp', (req, res) => res.sendStatus(405));

  router.post('/mcp', async (req, res) => {
    const msg = req.body;
    if (!msg || msg.jsonrpc !== '2.0') {
      return res.status(400).json({ jsonrpc: '2.0', id: msg && msg.id, error: { code: -32600, message: 'Invalid Request' } });
    }

    // A JSON-RPC notification or response carries no id and expects no reply.
    if (msg.id === undefined) {
      return res.status(202).end();
    }

    try {
      const version = declaredVersion(msg);
      if (version !== undefined && msg.method !== 'initialize') {
        return await handleModern(req, res, msg, version);
      }

      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params && msg.params.protocolVersion;
          return res.json(
            rpcResult(msg.id, {
              protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            })
          );
        }

        case 'ping':
          return res.json(rpcResult(msg.id, {}));

        case 'tools/list':
          return res.json(rpcResult(msg.id, { tools: TOOLS }));

        case 'tools/call': {
          const out = await toolCallResult(req, msg.params);
          if (!out) {
            return res.json(rpcError(msg.id, -32602, `Unknown tool: ${msg.params && msg.params.name}`));
          }
          return res.json(rpcResult(msg.id, out));
        }

        // A legacy-era client that probes with discover (no _meta version)
        // still learns what we speak.
        case 'server/discover':
          return res.json(rpcResult(msg.id, {
            supportedVersions: ALL_PROTOCOLS,
            capabilities: { tools: {} },
            instructions: INSTRUCTIONS,
            ttlMs: LIST_TTL_MS,
            cacheScope: 'public',
            resultType: 'complete',
            _meta: { [META_SERVER_INFO]: SERVER_INFO },
          }));

        default:
          return res.json(rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
      }
    } catch (err) {
      return res.json(rpcError(msg.id, -32603, `Internal error: ${err.message}`));
    }
  });

  return router;
}

module.exports = { createMcpRouter, TOOLS, PROTOCOL_VERSION, SERVER_VERSION, ALL_PROTOCOLS, MODERN_PROTOCOLS };
