# The agent model lineup (Studio + Cloudflare Workers AI)

A starting lineup of 10 models our agents work with: each strong at something
different, each backed by leaderboard results, each available on **Cloudflare
Workers AI** (`@cf/...`), and each runnable on the **Mac Studio** (M1 Max, 32 GB
unified memory, llama.cpp/Metal) from a GGUF with the same model family name.

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
| `@cf/deepseek-ai/deepseek-v4-flash-0731` / `deepseek-v4.1-flash-1017` | DeepSeek V4 Flash (small MoE) | ~15–20 GB (verify GGUF) |
| `@cf/qwen/qwen3-30b-a3b-fp8` | Qwen3 30B A3B (3 B active) | ~18 GB |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | Mistral Small 3.1 24B dense | ~14 GB |
| `@cf/openai/gpt-oss-20b` | GPT-OSS 20B dense | 12 GB (MXFP4) |
| `@cf/qwen/qwen3.8-27b` | Qwen3.8 27B dense | ~16 GB |
| `@cf/google/gemma-4-26b-a4b-it` | Gemma 26B A4B (4 B active) | ~15 GB (verify GGUF) |
| `@cf/zai-org/glm-5.3-flash` | GLM-5.3-Flash (small) | ~5–10 GB (verify GGUF) |
| `@cf/ibm-granite/granite-4.0-h-micro` | Granite 4.0 H Micro (~3 B) | 3.4 GB (Q8) |

**Decision models** (already local, already measured):

| CF name | Local |
|---|---|
| `@cf/cloudflare/clef-flash` | Clef-Flash-Q4_K_M (6.15 GB) ✓ |
| `typesafe/jev` | OpenJev-Q4_K_M (19.4 GB) ✓ |

**Too big for the Studio (cloud-only escalation):** `@cf/meta/llama-3.3-70b`
(40 GB Q4), `@cf/meta/llama-4-scout-17b-16e-instruct` (109 B total → 46 GB+),
`@cf/nvidia/nemotron-3-120b-a12b` (65 GB), `@cf/openai/gpt-oss-120b` (65 GB),
`@cf/moonshotai/kimi-k2.6` / `kimi-k2.7-code` (1 T MoE). These stay available on
the gateway; they just can't run on this box.

## The lineup (proposal)

Ten models, one distinct role each, all on CF Workers AI and all local-runnable:

| # | Role | Model (logical id) | CF name | Leaderboards |
|---|---|---|---|---|
| 1 | Coding — fast | `deepseek-v4.1-flash` | `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | Aider polyglot, LiveBench, SWE-bench Verified |
| 2 | Coding — agentic | `qwen3-30b-a3b` | `@cf/qwen/qwen3-30b-a3b-fp8` | LMArena, HF Open LLM Leaderboard, Aider |
| 3 | Tool calling | `mistral-small-3.1-24b` | `@cf/mistralai/mistral-small-3.1-24b-instruct` | BFCL, LMArena, multilingual (MMMLU) |
| 4 | Reasoning | `gpt-oss-20b` | `@cf/openai/gpt-oss-20b` | LMArena, LiveBench, MMLU-Pro |
| 5 | Dense generalist | `qwen3.8-27b` | `@cf/qwen/qwen3.8-27b` | HF Open LLM, LiveBench, LMArena |
| 6 | Creative/general | `gemma-4-26b-a4b` | `@cf/google/gemma-4-26b-a4b-it` | LMArena, MMLU-Pro, HF Open LLM |
| 7 | Multilingual (zh) | `glm-5.3-flash` | `@cf/zai-org/glm-5.3-flash` | LMArena, SuperCLUE, HF Open LLM |
| 8 | Tiny/fast | `granite-4.0-h-micro` | `@cf/ibm-granite/granite-4.0-h-micro` | HF Open LLM (≤3B tier), IBM benchmarks |
| 9 | Judge — light | `clef-flash` | `@cf/cloudflare/clef-flash` | TypeSafe System One (already local, 617 ms) |
| 10 | Judge — deep | `jev` | `typesafe/jev` | TypeSafe System One (already local, 1254 ms) |

The `.tsf` roster then names these logical ids; the local provider resolves them
to a GGUF alias and the `cloudflare-ai-gateway` provider resolves them to `@cf/...`
— same name, two backends.

## Open items before download

1. **DeepSeek V4.1 Flash** and **Gemma 4 26B** GGUF availability + exact footprint
   need one HuggingFace check before downloading (both may be newer than the GGUF
   mirrors).
2. If the goal is **10 text models** rather than 8 text + 2 judge, two more text
   models must come from outside the CF catalog (e.g. `Qwen2.5-Coder-7B`,
   `Llama-3.1-8B`) — those run locally but have no `@cf/...` twin. Trade-off to
   decide.
3. Once the lineup is chosen, download the GGUFs into
   `/Users/Shared/studio-models/gguf` and capture per-model tokens/s + cold-load
   the same way Clef/OpenJev were measured.
