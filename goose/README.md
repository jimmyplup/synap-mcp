# Linkrra (Synap) for goose

A [goose](https://github.com/aaif-goose/goose) custom-provider file for **Synap by Linkrra**:
open-weight models served on Linkrra's own GPUs behind an OpenAI-compatible API, billed per token.

## Install

**1. Get an API key.** Sign in at <https://synap.linkrra.com/ai/account.html> and create a key.
`qwen3-coder-30b` has a free tier (100,000 tokens/day), so you can try it before adding credits.

**2. Download the provider file** into goose's `custom_providers` directory.

macOS / Linux:

```sh
mkdir -p ~/.config/goose/custom_providers
curl -fsSL https://raw.githubusercontent.com/jimmyplup/synap-mcp/main/goose/linkrra.json \
  -o ~/.config/goose/custom_providers/linkrra.json
```

Windows (PowerShell):

```powershell
$dir = "$env:APPDATA\Block\goose\config\custom_providers"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest https://raw.githubusercontent.com/jimmyplup/synap-mcp/main/goose/linkrra.json -OutFile "$dir\linkrra.json"
```

**3. Add your key.** Either:

- **goose Desktop:** Settings → Models → Configure providers → **Linkrra (Synap)** → paste the key (stored in your keychain), or
- **CLI / environment:**

  ```sh
  export LINKRRA_API_KEY="your-key"
  goose session --provider linkrra --model qwen3-coder-30b
  ```

The file contains no credentials. goose reads the key from `LINKRRA_API_KEY` or the keychain.

## Models

| Model id | Context | Input $/1M | Output $/1M | Good for |
|---|---|---|---|---|
| `qwen3-coder-30b` | 32,768 | 0.0675 | 0.27 | Coding sessions (recommended default) |
| `qwen/qwen3-30b-a3b` | 65,536 | 0.0585 | 0.2438 | General chat and agent work, longer context |
| `gemma-4-26b-a4b-it` | 131,072 | 0.04 | 0.21 | Long files and documents |

Prices are also declared per token in the JSON, so goose's cost tracking shows real numbers.
Live prices: `https://pool.linkrra.com/v1/models?format=openrouter`.

## What is supported

- **API:** OpenAI-compatible chat completions at `https://pool.linkrra.com/v1/chat/completions`
- **Tool calling:** yes, on every listed model (goose's developer extension tested end-to-end)
- **Streaming:** yes, including `stream_options.include_usage`
- **Custom headers:** none required
- **Model list:** static (`dynamic_models: false`). The plain `/v1/models` endpoint also lists models we resell from other providers. This file only lists models running on our own GPUs.
- **Quantization:** models are served 4-bit quantized. Quality and speed differ from full-precision hosts.
- **Free tier:** `qwen3-coder-30b` only, 100,000 tokens/day. goose sends ~6-7K prompt tokens per turn (system prompt + tool list), so the free tier covers roughly a dozen turns a day.

## Verified

Tested on 2026-10-19 with goose CLI 1.54.0 (`goose run --provider linkrra --with-builtin developer`).
Each listed model called the `shell` tool and returned its output.

## Troubleshooting

- **"Please check your account with your provider to add more credits"**: the API returned 402. Before
  streaming, it checks your balance against the full request (goose's ~6-7K-token prompt plus the
  expected output). Top up at <https://synap.linkrra.com/ai/account.html> (USDC works today), or switch to
  `qwen3-coder-30b`, which has the free tier.
- **401:** the key isn't reaching goose. Check `echo $LINKRRA_API_KEY`, or re-enter it in Desktop.
- Support: weare@linkrra.com
