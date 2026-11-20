# Zero bootstrap: the proof run

One command takes this system from zero to tested local models across the mesh. This is the verbatim output of the run that passed (`exit 0`), with host names as they appear in `mesh.json` and no addresses or tokens.

Reproduce it on a machine with the same mesh:

```bash
cd apps/dpi-mcp && npx tsx scripts/zero.mts          # the dialog; Enter submits the pre-checked set
npx tsx scripts/zero.mts --yes                     # no dialog: take the defaults
```

What the run shows:

- **Discovery** reads every host in `mesh.json` over Cloudflare Access. A host that refuses its token is reported as `access denied`, not as having no model server.
- **The dialog** pre-checks every discovered model. Enter submits; numbers toggle; `a` and `n` set all or none.
- **Live tests** are local only. Every enabled model answers the same probe: a decision for `jev-quality`, a chat reply for `agent`.
- **Realized cost** is electricity only. Opportunity (wait) cost is not counted. Cloud-equivalent cost is priced from each run's tokens against its cloud twin, and only where a twin with a catalog price exists. Nothing is called in the cloud.
- **A/B coverage** draws 300 selections per required purpose. Every eligible model is reached, and none outside the filter is.

```text
== mesh
  studio         9 local model(s)
  macbook-pro    1 local model(s)

Which local models do you want to enable for the start?  [x] = auto-selected
  [x]  1. Clef-Flash-Q4_K_M                            decision on studio
  [x]  2. Mistral-Small-3.1-24B-Instruct-2503-Q4_K_M   llm      on studio
  [x]  3. OpenJev-Q4_K_M                               decision on studio
  [x]  4. Qwen3-30B-A3B-Q4_K_M                         llm      on studio
  [x]  5. Qwen3.8-27B-UD-Q4_K_M                        llm      on studio
  [x]  6. clairic-flash-Q4_K_M                         llm      on studio
  [x]  7. gemma-4-26B-A4B-it-UD-Q4_K_M                 llm      on studio
  [x]  8. gpt-oss-20b-MXFP4                            llm      on studio
  [x]  9. granite-4.0-h-micro-Q4_K_M                   llm      on studio
  [x] 10. granite-4.0-h-micro-Q4_K_M                   llm      on macbook-pro

Enter = submit the [x] set · numbers toggle · a = all · n = none: 
== enabling 10 of 10 model(s)

== testing (live, local only)
  ✓ [1/10] studio/Clef-Flash-Q4_K_M  6.4s  approve (0.83)  (cloud-equiv $0.000006 vs electricity $0.000013)
  ✓ [2/10] studio/Mistral-Small-3.1-24B-Instruct-2503-Q4_K_M  15.8s  OK  (cloud: no priced twin)
  ✓ [3/10] studio/OpenJev-Q4_K_M  23.5s  approve (0.99)  (cloud: no priced twin)
  ✓ [4/10] studio/Qwen3-30B-A3B-Q4_K_M  25.5s  OK  (cloud-equiv $0.000044 vs electricity $0.000053)
  ✓ [5/10] studio/Qwen3.8-27B-UD-Q4_K_M  22.7s  OK  (cloud: no priced twin)
  ✓ [6/10] studio/clairic-flash-Q4_K_M  7.3s  OK  (cloud: no priced twin)
  ✓ [7/10] studio/gemma-4-26B-A4B-it-UD-Q4_K_M  18.3s  OK  (cloud: no priced twin)
  ✓ [8/10] studio/gpt-oss-20b-MXFP4  16.3s  OK  (cloud-equiv $0.000027 vs electricity $0.000034)
  ✓ [9/10] studio/granite-4.0-h-micro-Q4_K_M  2.1s  OK  (cloud: no priced twin)
  ✓ [10/10] macbook-pro/granite-4.0-h-micro-Q4_K_M  1.2s  OK  (cloud: no priced twin)

== realized cost (electricity only; wait time not counted)
  priced runs (3, a cloud twin exists): electricity $0.000100  vs  cloud $0.000076  →  saved $-0.000024
  all runs (10): electricity $0.000290  (7 run(s) have no priced cloud twin, so they are not compared)

== A/B selection (300 draws per required purpose)
  required [jev-quality]: 2 reachable, 0 leaked  studio-decision-clef-flash-q4-k-m=146  studio-decision-openjev-q4-k-m=154
  required [agent]: 8 reachable, 0 leaked  studio-llm-mistral-small-3-1-24b-instruct-2503-q4-k-m=38  studio-llm-qwen3-8-27b-ud-q4-k-m=30  studio-llm-gemma-4-26b-a4b-it-ud-q4-k-m=38  studio-llm-gpt-oss-20b-mxfp4=43  macbook-pro-llm-granite-4-0-h-micro-q4-k-m=41  studio-llm-granite-4-0-h-micro-q4-k-m=49  studio-llm-qwen3-30b-a3b-q4-k-m=36  studio-llm-clairic-flash-q4-k-m=25

selection mode: ab (A/B random, filtered by the required capabilities)
all models tested, systems a go.
```
