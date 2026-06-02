#!/usr/bin/env python3
"""GPU latency/throughput benchmark for Qwen3-Reranker-0.6B (R&D, RTX 4070).

Loads the PINNED local artifact (offline, trust_remote_code=False) on CUDA and
measures the bounded production rerank shape: 1 query x N candidates scored in one
batched forward. Reports cold-load (NOT hidden), warm p50/p95/p99, throughput,
peak VRAM, across candidate counts {2,4,8,16} x input buckets {short,med,long}.
Determines honestly whether warm p95 <= 50 ms holds for the production shape
(~4 candidates, medium docs). Output: JSON to stdout. Latency probes are SYNTHETIC
inputs (not organic traffic); quality is measured separately by run-bakeoff.ts.
"""
import json
import os
import statistics
import sys
import time

MODEL_DIR = os.environ.get("TB_QWEN_MODEL_DIR")
INSTRUCTION = "Given a coding problem, retrieve prior reasoning lessons whose mechanism applies"
PREFIX = ('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query '
          'and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n')
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
BUCKET_TOKENS = {"short": 20, "med": 80, "long": 200}
CAND_COUNTS = [2, 4, 8, 16]
WARM_ITERS = 30
WARMUP = 5


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, int(round((p / 100.0) * len(xs)) - 1)))]


def main():
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    assert torch.cuda.is_available(), "CUDA not available"
    dev = "cuda"
    out = {"device": torch.cuda.get_device_name(0), "torch": torch.__version__, "dtype": "float16"}

    t0 = time.perf_counter()
    tok = AutoTokenizer.from_pretrained(MODEL_DIR, padding_side="left", trust_remote_code=False, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(MODEL_DIR, trust_remote_code=False, local_files_only=True, torch_dtype=torch.float16).to(dev).eval()
    torch.cuda.synchronize()
    out["cold_load_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    true_id = tok.convert_tokens_to_ids("yes")
    false_id = tok.convert_tokens_to_ids("no")
    pre = tok.encode(PREFIX, add_special_tokens=False)
    suf = tok.encode(SUFFIX, add_special_tokens=False)

    def doc_of(n_tokens):
        return ("rounding error accumulates low order bits order of operations " * (n_tokens // 8 + 1))

    def score(query, docs):
        ids = []
        for d in docs:
            body = "<Instruct>: {i}\n<Query>: {q}\n<Document>: {d}".format(i=INSTRUCTION, q=query, d=d)
            seq = pre + tok.encode(body, add_special_tokens=False)[: 8192 - len(pre) - len(suf)] + suf
            ids.append(seq)
        enc = tok.pad({"input_ids": ids}, padding=True, return_tensors="pt").to(dev)
        with torch.no_grad():
            logits = model(**enc).logits[:, -1, :]
        pair = torch.stack([logits[:, false_id], logits[:, true_id]], dim=1)
        return torch.nn.functional.log_softmax(pair, dim=1)[:, 1].exp().tolist()

    q = "running total off by a tiny fraction after many additions"
    # cold first-inference (separate from warm)
    tc = time.perf_counter()
    score(q, [doc_of(80)] * 4)
    torch.cuda.synchronize()
    out["cold_first_infer_ms"] = round((time.perf_counter() - tc) * 1000, 1)

    cells = []
    torch.cuda.reset_peak_memory_stats()
    for bucket, ntok in BUCKET_TOKENS.items():
        for n in CAND_COUNTS:
            docs = [doc_of(ntok)] * n
            for _ in range(WARMUP):
                score(q, docs)
            torch.cuda.synchronize()
            lat = []
            for _ in range(WARM_ITERS):
                s = time.perf_counter()
                score(q, docs)
                torch.cuda.synchronize()
                lat.append((time.perf_counter() - s) * 1000)
            mean = statistics.mean(lat)
            cells.append({
                "bucket": bucket, "candidates": n,
                "p50_ms": round(pct(lat, 50), 1), "p95_ms": round(pct(lat, 95), 1), "p99_ms": round(pct(lat, 99), 1),
                "throughput_pairs_per_s": round(n / (mean / 1000.0), 1),
            })
    out["peak_vram_mb"] = round(torch.cuda.max_memory_allocated() / (1024 * 1024), 1)
    out["cells"] = cells
    # production shape verdict: 4 candidates, medium docs
    prod = next(c for c in cells if c["candidates"] == 4 and c["bucket"] == "med")
    out["production_shape"] = {"candidates": 4, "bucket": "med", "warm_p95_ms": prod["p95_ms"], "rail_50ms": "PASS" if prod["p95_ms"] <= 50 else "OVER"}
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    if not MODEL_DIR or not os.path.isdir(MODEL_DIR):
        print(json.dumps({"error": "TB_QWEN_MODEL_DIR missing", "dir": MODEL_DIR}))
        sys.exit(2)
    main()
