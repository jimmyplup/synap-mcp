'use strict';

/**
 * Offline test of the stdio bridge: a local HTTP mock records what the bridge
 * sends and answers like the hosted server. Asserts the properties a bridge can
 * get wrong — header mirroring for both protocol eras, the key forwarded
 * untouched, notifications producing no output, and an unreachable endpoint
 * surfacing as a JSON-RPC error instead of silence.
 *
 * Run: node test/test-bridge.js
 */

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'synap-mcp.js');

function mock() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({ headers: req.headers, msg });
      if (msg.id === undefined) { res.statusCode = 202; return res.end(); }
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '0' } }
        : { ok: msg.method };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

function runBridge(url, lines, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN], { env: { ...process.env, SYNAP_MCP_URL: url, SYNAP_API_KEY: 'sk-test', ...env } });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('exit', () => resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    for (const l of lines) p.stdin.write(`${JSON.stringify(l)}\n`);
    p.stdin.end();
  });
}

(async () => {
  const { server, seen, url } = await mock();
  try {
    const modernMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const out = await runBridge(url, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } },
    ]);
    assert.strictEqual(out[0].result.protocolVersion, '2025-11-25');

    // Legacy: version learned from initialize is carried on the next request
    // in the same process; a notification produces no stdout line.
    const out2 = await runBridge(url, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } },
    ]);
    assert.strictEqual(out2.length, 1);

    seen.length = 0;
    const legacy = await new Promise((resolve) => {
      const p = spawn(process.execPath, [BIN], { env: { ...process.env, SYNAP_MCP_URL: url, SYNAP_API_KEY: 'sk-test' } });
      let buf = '';
      p.stdout.on('data', (c) => {
        buf += c;
        const lines = buf.split('\n').filter(Boolean);
        if (lines.length === 1 && seen.length === 1) {
          p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
          p.stdin.end();
        }
      });
      p.on('exit', () => resolve(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    });
    assert.strictEqual(legacy.length, 2, 'notification must not produce output');
    const list = seen.find((s) => s.msg.method === 'tools/list');
    assert.strictEqual(list.headers['mcp-protocol-version'], '2025-11-25');
    assert.strictEqual(list.headers['mcp-method'], 'tools/list');
    assert.strictEqual(list.headers.authorization, 'Bearer sk-test');
    console.log('  ok - legacy era: negotiated version carried, notification silent, key forwarded');

    // Modern: version mirrored from _meta, Mcp-Name set, non-ASCII base64-sentinel encoded.
    seen.length = 0;
    await runBridge(url, [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { _meta: modernMeta, name: 'synap_list_models', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { _meta: modernMeta, name: 'outil_é', arguments: {} } },
    ]);
    const a = seen.find((s) => s.msg.id === 3);
    assert.strictEqual(a.headers['mcp-protocol-version'], '2026-07-28');
    assert.strictEqual(a.headers['mcp-method'], 'tools/call');
    assert.strictEqual(a.headers['mcp-name'], 'synap_list_models');
    const b = seen.find((s) => s.msg.id === 4);
    assert.strictEqual(b.headers['mcp-name'], `=?base64?${Buffer.from('outil_é').toString('base64')}?=`);
    console.log('  ok - 2026-07-28 era: MCP-Protocol-Version/Mcp-Method/Mcp-Name mirrored, non-ASCII encoded');

    // No key: nothing is invented.
    seen.length = 0;
    await runBridge(url, [{ jsonrpc: '2.0', id: 5, method: 'tools/list' }], { SYNAP_API_KEY: '' });
    assert.ok(!('authorization' in seen[0].headers));
    console.log('  ok - no SYNAP_API_KEY -> no Authorization header');

    // Unreachable endpoint -> JSON-RPC error, not silence.
    const dead = await runBridge('http://127.0.0.1:1/mcp', [{ jsonrpc: '2.0', id: 6, method: 'tools/list' }]);
    assert.strictEqual(dead[0].id, 6);
    assert.strictEqual(dead[0].error.code, -32603);
    console.log('  ok - unreachable endpoint answers the request with -32603');

    console.log('\n4 passed, 0 failed');
  } catch (err) {
    console.error(`  FAIL\n${err.stack}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
