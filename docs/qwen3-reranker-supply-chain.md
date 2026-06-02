# Supply-chain manifest — Qwen3-Reranker-0.6B (R&D)

> Verified from the Hugging Face model API + card on **2026-06-02** before any
> download. The model is **optional and isolated from serving** — it is never
> imported by the runtime, only by the offline bakeoff worker, and only if the
> revision-pinned, hash-verified weights are present locally.

## Pinned artifact

| field | value |
|---|---|
| repo | `Qwen/Qwen3-Reranker-0.6B` |
| **revision (pinned)** | `e61197ed45024b0ed8a2d74b80b4d909f1255473` |
| license | **apache-2.0** |
| architecture | `Qwen3ForCausalLM` (model_type `qwen3`) |
| **trust_remote_code** | **false** — `Qwen3ForCausalLM` is a core `transformers` architecture (≥4.51.0); the repo ships **no** custom modeling `*.py`, so no remote code executes |
| runtime requirement | `transformers >= 4.51.0`, `torch` |

## Artifact hashes (sha256, LFS OID) + sizes

| file | size (bytes) | sha256 |
|---|---|---|
| `model.safetensors` | 1,191,588,280 (≈1.19 GB) | `27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b` |
| `tokenizer.json` | 11,422,654 | `aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4` |
| `config.json` | 727 | (non-LFS) |
| `tokenizer_config.json` | 9,706 | (non-LFS) |
| `vocab.json` | 2,776,833 | (non-LFS) |
| `merges.txt` | 1,671,853 | (non-LFS) |

`scripts/semantic-bakeoff/download_qwen.py` downloads ONLY this revision into a
gitignored `.models/` dir and **refuses** unless `model.safetensors` matches the
sha256 above. Source: <https://huggingface.co/Qwen/Qwen3-Reranker-0.6B> ·
API: `https://huggingface.co/api/models/Qwen/Qwen3-Reranker-0.6B?blobs=true`.

## Isolation guarantees

- The weights live under `.models/` (gitignored) — never committed, never on the
  serving path. The frozen D.5 runtime (`interesting-mcclintock-a69a77`) and the
  live dogfood MCP do **not** reference this model.
- Inference runs in a **separate Python worker process** (`qwen-worker.py`) behind
  the provider-agnostic JSONL adapter, with the host scanning every DTO before
  transport. The worker is spawned only by the offline bakeoff, never by serving.
- `trust_remote_code=False` is passed explicitly; loading aborts if the repo ever
  tries to require remote code.

## Inference recipe (verified from the model card)

P(relevant) = softmax over the last-token logits of the `"yes"` vs `"no"` tokens,
with the documented system/user/assistant template (`Judge whether the Document
meets the requirements …`), `padding_side='left'`, max length 8192. Implemented in
`qwen-worker.py`. The bakeoff maps P(yes) → verdict (applicable / uncertain /
inapplicable) at fixed thresholds so it is comparable to the deterministic
baseline; thresholds are bakeoff-local and never touch the serving policy.
