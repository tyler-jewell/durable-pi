# The agent model lineup (Studio + Cloudflare Workers AI)

A starting lineup of models our agents work with: each strong at something

different, each backed by leaderboard results, each available on **Cloudflare
Workers AI** (`@cf/...`), and each runnable on the **Mac Studio** (M1 Max, 32 GB
unified memory, llama.cpp/Metal) from a GGUF with the same model family name.

## The single source of truth

Model files are **not** the SSoT. The SSoT is the manifest, per the router
presets' own rule ("Model facts, sizes, hashes and licenses live only in
`models/manifest.json`"):

- **`~/local/models/manifest.json`** — the canonical registry on the
  Studio: every model's id, kind, role, CF name, GGUF file, quant, size, license,
  status (local/staging/pending) and benchmark.
- `~/local/models/gguf/` + `mlx/` — storage (GGUF for llama.cpp, MLX
  for Apple-native).
- `~/local/models/llama-models.ini` — the router presets (one GGUF
  served at a time on `:8080`, `--models-max 1`).
- the macOS Shared models area — import/staging only (the import tarball lives
  there); it is **not** the model root.

## Measured baselines (19 Nov 2026, Studio)

The two decision models already on the Studio, benchmarked on `/v1/systemone`
(llama.cpp 1.0.0, `--n-gpu-layers 999`, `--ctx-size 4096`):

| Model | Params | Metal mem | Cold load | Warm decision | Decisions/sec | Tokens/call (in/out) |
|---|---|---|---|---|---|---|
| Clef-Flash-Q4_K_M | ~9 B | 6.15 GB | 1.28 s (wake) | **617 ms** (median) | 1.62 | 207 / 0 |
| OpenJev-Q4_K_M | ~30 B | 19.4 GB (GGUF) | 33.5 s | **1254 ms** (median) | 0.78 | 63 / 0 |

Metal reports 26.8 GB usable for model + context on this box; Clef leaves ~20 GB
headroom, OpenJev ~7 GB. Text-model tokens/s is not yet measurable (no text GGUF
is installed) — it is captured for each lineup pick when its GGUF lands.

## The Cloudflare Workers AI catalog (24 models)

The `cloudflare-ai-gateway` provider catalog. Split by whether a GGUF of the same
family fits the Studio's 32 GB:

**Local-runnable (GGUF fits 32 GB)** — the lineup lives here:

| CF name | Family / active params | Local Q4 footprint |
|---|---|---|
| `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | DeepSeek V4.1 Flash (~7 B) | **7.98 GB Q8_0** |
| `@cf/qwen/qwen3-30b-a3b-fp8` | Qwen3 30B A3B (3 B active) | **18.56 GB Q4_K_M** |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | Mistral Small 3.1 24B dense | **14.33 GB Q4_K_M** |
| `@cf/openai/gpt-oss-20b` | GPT-OSS 20B dense | 12.1 GB MXFP4 (already local) |
| `@cf/qwen/qwen3.8-27b` | Qwen3.8 27B dense | **16.56 GB Q4_K_M** |
| `@cf/google/gemma-4-26b-a4b-it` | Gemma 26B A4B (4 B active) | **16.95 GB Q4_K_M** |
| `@cf/ibm-granite/granite-4.0-h-micro` | Granite 4.0 H Micro (~3 B) | **1.94 GB Q4_K_M** |

**Decision models** (already local, already measured):

| CF name | Local |
|---|---|
| `@cf/cloudflare/clef-flash` | Clef-Flash-Q4_K_M (6.15 GB) ✓ |
| `typesafe/jev` | OpenJev-Q4_K_M (19.4 GB) ✓ |
| `@cf/cloudflare/clairic-flash` | clairic-flash-Q4_K_M (5.7 GB, downloading) |

**Too big for the Studio (cloud-only escalation):** `@cf/meta/llama-3.3-70b`
(40 GB Q4), `@cf/meta/llama-4-scout-17b-16e-instruct` (109 B total → 46 GB+),
`@cf/nvidia/nemotron-3-120b-a12b` (65 GB), `@cf/openai/gpt-oss-120b` (65 GB),
`@cf/moonshotai/kimi-k2.6` / `kimi-k2.7-code` (1 T MoE), and **`@cf/zai-org/glm-5.3-flash`
(314 B MoE → 99 GB Q4_K_M)**. These stay on the gateway; they can't run on this box.
Multilingual (zh) is covered locally by Qwen3-30B-A3B and Mistral-Small.

## The lineup (proposal)

Ten models, one distinct role each, all on CF Workers AI and all local-runnable:

| # | Role | Model (logical id) | CF name | Leaderboards |
|---|---|---|---|---|
| 1 | Coding — fast | `deepseek-v4.1-flash` | `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | Aider polyglot, LiveBench, SWE-bench Verified |
| 2 | Coding — agentic | `qwen3-30b-a3b` | `@cf/qwen/qwen3-30b-a3b-fp8` | LMArena, HF Open LLM Leaderboard, Aider |
| 3 | Tool calling / multilingual | `mistral-small-3.1-24b` | `@cf/mistralai/mistral-small-3.1-24b-instruct` | BFCL, LMArena, MMMLU |
| 4 | Reasoning | `gpt-oss-20b` | `@cf/openai/gpt-oss-20b` | LMArena, LiveBench, MMLU-Pro |
| 5 | Dense generalist | `qwen3.8-27b` | `@cf/qwen/qwen3.8-27b` | HF Open LLM, LiveBench, LMArena |
| 6 | Creative/general | `gemma-4-26b-a4b` | `@cf/google/gemma-4-26b-a4b-it` | LMArena, MMLU-Pro, HF Open LLM |
| 7 | Tiny/fast | `granite-4.0-h-micro` | `@cf/ibm-granite/granite-4.0-h-micro` | HF Open LLM (≤3B tier), IBM benchmarks |
| 8 | Judge — light | `clef-flash` | `@cf/cloudflare/clef-flash` | TypeSafe System One (already local, 617 ms) |
| 9 | Judge — deep | `jev` | `typesafe/jev` | TypeSafe System One (already local, 1254 ms) |
| 10 | Numeric extract/forecast | `clairic-flash` | `@cf/cloudflare/clairic-flash` | Cloudflare System One (Apache 2.0, cherry on top) |

The `.tsf` roster then names these logical ids; the local provider resolves them
to a GGUF alias and the `cloudflare-ai-gateway` provider resolves them to `@cf/...`
— same name, two backends.

## The cherry on top — Clairic (11th model)

Cloudflare's newest open-weight model (Apache 2.0), a **System One-style numeric
model**: it extracts, computes, estimates and forecasts typed values with
confidence/probabilities — the third decision kind beside Clef (choice/noul) and
Jev (judgment).

| Model | CF name | Local | Size | Role |
|---|---|---|---|---|
| Clairic Flash (~9.7 B) | `@cf/cloudflare/clairic-flash` | `clairic-flash-Q4_K_M.gguf` + `mmproj` (vision) | 5.7 GB | numeric extract/forecast |
| Clairic (~27.8 B) | `@cf/cloudflare/clairic` | CF-only (no GGUF yet) | — | numeric extract/forecast (full) |

Clairic-flash fits the Studio beside Clef-flash (5.7 + 6.7 GB) and adds a
forecast/estimate capability to the factory's judge tier.

## Download state (19 Nov 2026)

The canonical root is `~/local/models/` (manifest.json = SSoT). Verified
GGUF files and their exact sizes:

| Model | GGUF (Q4_K_M unless noted) | Size | Status |
|---|---|---|---|
| gpt-oss-20b | gpt-oss-20b-MXFP4.gguf | 12.1 GB | local ✓ (~40 tok/s) |
| clef-flash | Clef-Flash-Q4_K_M.gguf | 6.7 GB | local ✓ (617 ms) |
| openjev | OpenJev-Q4_K_M.gguf | 19.4 GB | local ✓ (1254 ms) |
| clairic-flash | clairic-flash-Q4_K_M.gguf (+ mmproj) | 5.7 GB | downloading |
| deepseek-v4.1-flash | dspark-DeepSeek-V4.1-Flash-1017-Q8_0.gguf | 7.98 GB | downloading |
| qwen3-30b-a3b | Qwen3-30B-A3B-Q4_K_M.gguf | 18.56 GB | downloading |
| mistral-small-3.1-24b | Mistral-Small-3.1-24B-Instruct-2503-Q4_K_M.gguf | 14.33 GB | downloading |
| qwen3.8-27b | Qwen3.8-27B-UD-Q4_K_M.gguf | 16.56 GB | downloading |
| gemma-4-26b-a4b | gemma-4-26B-A4B-it-UD-Q4_K_M.gguf | 16.95 GB | downloading |
| granite-4.0-h-micro | granite-4.0-h-micro-Q4_K_M.gguf | 1.94 GB | downloading |

`glm-5.3-flash` was dropped from the local lineup (314 B MoE, 99 GB Q4_K_M) and
stays CF-only. Once each GGUF lands, its tokens/s + cold-load are measured and
recorded in manifest.json.
3. Once the lineup is chosen, download the GGUFs into
   `~/local/models/gguf` and capture per-model tokens/s + cold-load
   the same way Clef/OpenJev were measured.
