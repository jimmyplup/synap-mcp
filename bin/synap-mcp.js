#!/usr/bin/env node
'use strict';

/**
 * synap-mcp — stdio transport for the hosted Synap MCP server.
 *
 * The server itself runs at https://pool.linkrra.com/mcp (Streamable HTTP).
 * Many MCP hosts (Claude Desktop, Cursor, Cline, Windsurf, Zed) launch a
 * local command and speak newline-delimited JSON-RPC over stdin/stdout; this
 * file is that command. It forwards each message to the hosted endpoint
 * unchanged and writes the reply back, so there is exactly one implementation
 * of the tools — the hosted one — and this bridge cannot drift from it.
 *
 * Both protocol eras pass through:
 *  - legacy (2025-11-25 and earlier): `initialize` handshake; the negotiated
 *    version is remembered and sent as MCP-Protocol-Version on later requests.
 *  - 2026-07-28: stateless; each request carries its version in
 *    params._meta["io.modelcontextprotocol/protocolVersion"], which is mirrored
 *    into the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers the
 *    Streamable HTTP transport requires.
 *
 * Environment:
 *   SYNAP_API_KEY  your Synap key; sent as `Authorization: Bearer`. Needed only
 *                  for synap_chat_completion (the one billed tool).
 *   SYNAP_MCP_URL  override the endpoint (default https://pool.linkrra.com/mcp).
 *
 * Zero dependencies; Node 18+ (global fetch). Logs go to stderr only — stdout
 * is the protocol channel.
 */

const readline = require('node:readline');

const URL_ = process.env.SYNAP_MCP_URL || 'https://pool.linkrra.com/mcp';
const KEY = (process.env.SYNAP_API_KEY || '').trim();
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const VERSION = require("../package.json").version;

let negotiated = null; // legacy-era version from the initialize result
let inflight = 0;
let closing = false;

const log = (...a) => process.stderr.write(`[synap-mcp] ${a.join(' ')}\n`);
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

/** ASCII-safe header value, else the spec's Base64 sentinel. */
function headerValue(v) {
  const s = String(v);
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?base64?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function headersFor(msg) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': `synap-mcp/${VERSION}`,
  };
  if (KEY) h.Authorization = `Bearer ${KEY}`;
  const meta = msg.params && msg.params._meta;
  const version = (meta && typeof meta[META_VERSION] === 'string') ? meta[META_VERSION] : negotiated;
  if (version) h['MCP-Protocol-Version'] = version;
  if (msg.method) h['Mcp-Method'] = msg.method;
  const name = msg.params && (msg.params.name ?? msg.params.uri);
  if (name != null && ['tools/call', 'resources/read', 'prompts/get'].includes(msg.method)) {
    h['Mcp-Name'] = headerValue(name);
  }
  return h;
}

/** Write every JSON-RPC message in an SSE body (a server may answer that way). */
function relaySse(text) {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (data) {
      try { send(JSON.parse(data)); } catch (_) { log('dropped a non-JSON SSE event'); }
    }
  }
}

async function forward(msg) {
  const isRequest = msg && msg.id !== undefined && msg.method;
  let res;
  try {
    res = await fetch(URL_, { method: 'POST', headers: headersFor(msg), body: JSON.stringify(msg) });
  } catch (err) {
    log(`cannot reach ${URL_}: ${err.message}`);
    if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Synap MCP endpoint unreachable: ${err.message}` } });
    return;
  }
  const text = await res.text();
  if (!text) {
    if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Empty response (HTTP ${res.status})` } });
    return;
  }
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) return relaySse(text);
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Non-JSON response (HTTP ${res.status})` } });
    return;
  }
  if (msg.method === 'initialize' && body.result && typeof body.result.protocolVersion === 'string') {
    negotiated = body.result.protocolVersion;
  }
  send(body);
}

function main() {
  if (process.argv.includes('--version')) { process.stdout.write(`${VERSION}\n`); return; }
  if (!KEY) log('SYNAP_API_KEY is not set: listing models and estimating cost work, synap_chat_completion will be refused.');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    inflight++;
    forward(msg).catch((err) => log(err.stack || String(err))).finally(() => {
      inflight--;
      if (closing && inflight === 0) process.exit(0);
    });
  });
  rl.on('close', () => {
    closing = true;
    if (inflight === 0) process.exit(0);
  });
}

main();
