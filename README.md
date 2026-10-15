# Synap MCP server

[Synap by Linkrra](https://synap.linkrra.com) as a Model Context Protocol server: open models
behind one OpenAI-compatible API. Your agent can list the models we serve, read their prices and
limits, estimate the cost of a job before running it, and run a chat completion.

There is one server, hosted at `https://pool.linkrra.com/mcp` (Streamable HTTP). It is the
server behind `com.linkrra/synap` in the [official MCP registry](https://registry.modelcontextprotocol.io).

This repository has two parts:

- `routes.js` is the deployed router itself, byte for byte.
- `bin/synap-mcp.js` is the **stdio** transport (`npx synap-mcp`) for MCP hosts that launch a
  local command. It sends every message to the hosted server unchanged, so it always exposes
  the same tools as the hosted server.

## Tools

| Tool | Cost | Key needed |
|---|---|---|
| `synap_list_models` | free | no |
| `synap_get_model` | free | no |
| `synap_estimate_cost` | free | no |
| `synap_chat_completion` | billed per prompt and completion token | yes |

Model ids are the ones `synap_list_models` returns. Pass `synap-v1` and Synap picks the cheapest
model that can do the job.

## Connect

### Hosted (Streamable HTTP), no install needed

```json
{
  "mcpServers": {
    "synap": {
      "type": "http",
      "url": "https://pool.linkrra.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_SYNAP_API_KEY" }
    }
  }
}
```

### Local stdio (Claude Desktop, Cursor, Cline, Windsurf, Zed)

```json
{
  "mcpServers": {
    "synap": {
      "command": "npx",
      "args": ["-y", "synap-mcp"],
      "env": { "SYNAP_API_KEY": "YOUR_SYNAP_API_KEY" }
    }
  }
}
```

Without a key, the three free tools still work. `synap_chat_completion` returns an error and
nothing is charged.

| Variable | Meaning |
|---|---|
| `SYNAP_API_KEY` | Your Synap key, sent as `Authorization: Bearer`. Get one at https://synap.linkrra.com. |
| `SYNAP_MCP_URL` | Optional. Overrides the endpoint (default `https://pool.linkrra.com/mcp`). |

## Paying

- **API key (MCP and REST).** Top up a Synap account by card or crypto. Each call is billed
  per token against that balance. MCP always uses this method.
- **x402, no account.** An agent with a USDC wallet on Base can pay per call over plain HTTP at
  `POST https://pool.linkrra.com/api/billing/x402/chat/completions`. An unpaid request
  returns `402` with the payment terms. This route is part of the REST API, not an MCP tool.

## Protocol

The hosted server speaks both MCP eras:

- **2026-07-28 (current):** stateless. It implements `server/discover` and reads the
  per-request `_meta` protocol version. It checks that `MCP-Protocol-Version`, `Mcp-Method` and
  `Mcp-Name` match the request body. Results carry `resultType`, and list results also carry
  `ttlMs` and `cacheScope`.
- **2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05:** the `initialize` handshake.

The bridge works with both. For a legacy client, it remembers the version agreed during
`initialize`. For a 2026-07-28 client, it copies the `_meta` version into the HTTP headers
that the Streamable HTTP transport requires.

## The API behind it

`https://pool.linkrra.com/v1` is an OpenAI-compatible API. On every self-hosted model it
supports tool calling (`tools`, `tool_choice`) and structured outputs (`response_format`
`json_object` / `json_schema`). Requests can be streamed or not. Prompts and completions are
not stored.

## Auth

The server passes your key through and nothing else. The key travels in the standard
`Authorization: Bearer` header, the same way it would on a direct call to
`/v1/chat/completions`. `routes.js` forwards that header untouched. The server never reads,
stores or creates a key.

## Run the server standalone

```bash
npm install && npm start     # serves :8080/mcp
```

## Develop

```bash
npm test     # offline: a local mock checks the bridge's headers for both protocol eras
```

The stdio bridge needs Node 18 or later and has no dependencies.

## License

Apache-2.0
