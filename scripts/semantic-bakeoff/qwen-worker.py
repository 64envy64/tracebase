#!/usr/bin/env python3
"""Qwen3-Reranker-0.6B worker for the offline bakeoff (R&D, optional, isolated).

Speaks the SAME JSONL worker protocol as the deterministic fake worker
(src/experiments/semantic-bakeoff/worker-protocol.ts), so PersistentWorkerProvider
drives it with no model-specific host code. NEVER imported by the runtime; spawned
only by the offline bakeoff, only when revision-pinned hash-verified weights exist.

Loads strictly local + offline: trust_remote_code=False, local_files_only=True,
from TB_QWEN_MODEL_DIR. Implements the verified card recipe: P(relevant) = softmax
over the last-token "yes"/"no" logits. Maps P(yes) -> verdict at fixed
bakeoff-local thresholds (never the serving policy). All logging to stderr; only
protocol JSON to stdout.
"""
import json
import os
import sys

V = 1
APPLICABLE_AT = 0.60   # bakeoff-local verdict thresholds (NOT serving policy)
INAPPLICABLE_BELOW = 0.40
INSTRUCTION = "Given a coding problem, retrieve prior reasoning lessons whose mechanism applies"
PREFIX = ('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query '
          'and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n')
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def send(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


def main():
    model_dir = os.environ.get("TB_QWEN_MODEL_DIR")
    if not model_dir or not os.path.isdir(model_dir):
        log("qwen-worker: TB_QWEN_MODEL_DIR not set or missing:", model_dir)
        # Stay silent on hello so the host handshake times out -> fail open.
        return _serve(None, None, None, None, None, None)

    import torch  # noqa
    from transformers import AutoTokenizer, AutoModelForCausalLM

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log("qwen-worker: loading", model_dir, "device", device)
    tok = AutoTokenizer.from_pretrained(model_dir, padding_side="left", trust_remote_code=False, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_dir, trust_remote_code=False, local_files_only=True,
        torch_dtype=(torch.float16 if device == "cuda" else torch.float32),
    ).to(device).eval()
    true_id = tok.convert_tokens_to_ids("yes")
    false_id = tok.convert_tokens_to_ids("no")
    prefix_ids = tok.encode(PREFIX, add_special_tokens=False)
    suffix_ids = tok.encode(SUFFIX, add_special_tokens=False)
    log("qwen-worker: ready on", device)
    return _serve(torch, tok, model, device, true_id, false_id, prefix_ids, suffix_ids)


def _serve(torch, tok, model, device, true_id=None, false_id=None, prefix_ids=None, suffix_ids=None):
    ready_model = "Qwen/Qwen3-Reranker-0.6B" if model is not None else None

    def score_pairs(query, docs):
        import torch as T
        msgs = []
        for d in docs:
            body = "<Instruct>: {i}\n<Query>: {q}\n<Document>: {d}".format(i=INSTRUCTION, q=query, d=d)
            ids = prefix_ids + tok.encode(body, add_special_tokens=False)[: 8192 - len(prefix_ids) - len(suffix_ids)] + suffix_ids
            msgs.append(ids)
        enc = tok.pad({"input_ids": msgs}, padding=True, return_tensors="pt").to(device)
        with T.no_grad():
            logits = model(**enc).logits[:, -1, :]
        pair = T.stack([logits[:, false_id], logits[:, true_id]], dim=1)
        probs = T.nn.functional.log_softmax(pair, dim=1)[:, 1].exp().tolist()
        return probs

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except Exception:
            continue
        if not isinstance(m, dict) or m.get("v") != V:
            continue
        t = m.get("type")
        if t == "hello":
            if model is not None:
                send({"v": V, "id": m["id"], "type": "ready", "model": ready_model, "featureVersion": 1})
            # else: stay silent -> host handshake timeout -> fail open
        elif t == "rank":
            if model is None:
                send({"v": V, "id": m["id"], "type": "error", "message": "model not loaded"})
                continue
            try:
                q = m["query"]["literalText"] + (" " + m["query"].get("causalText", "") if m["query"].get("causalText") else "")
                docs = [" ".join((c.get("mechanism") or []) + (c.get("situation") or []) + (c.get("unlock") or [])) for c in m["candidates"]]
                probs = score_pairs(q, docs) if docs else []
                results = []
                for c, p in zip(m["candidates"], probs):
                    verdict = "applicable" if p >= APPLICABLE_AT else ("inapplicable" if p < INAPPLICABLE_BELOW else "uncertain")
                    results.append({"blockId": c["blockId"], "verdict": verdict, "confidence": float(p)})
                send({"v": V, "id": m["id"], "type": "result", "results": results})
            except Exception as e:  # never crash the protocol on one bad request
                send({"v": V, "id": m["id"], "type": "error", "message": str(e)[:200]})
        elif t == "shutdown":
            return


if __name__ == "__main__":
    main()
