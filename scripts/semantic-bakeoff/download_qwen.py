#!/usr/bin/env python3
"""Download Qwen3-Reranker-0.6B (R&D), revision-pinned + sha256-verified.

Downloads ONLY the verified revision into a gitignored .models/ dir and REFUSES
unless model.safetensors matches the expected sha256 from the supply-chain
manifest. trust_remote_code is irrelevant to download; the worker loads with it
False. Run: `python scripts/semantic-bakeoff/download_qwen.py`
"""
import hashlib
import os
import sys

REPO = "Qwen/Qwen3-Reranker-0.6B"
REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"
EXPECTED = {
    "model.safetensors": "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b",
    "tokenizer.json": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
}
ALLOW = ["model.safetensors", "tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt", "config.json", "generation_config.json"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.abspath(os.path.join(here, "..", "..", ".models", "qwen3-reranker-0.6b"))
    os.makedirs(target, exist_ok=True)
    from huggingface_hub import snapshot_download
    print(f"downloading {REPO}@{REVISION[:12]} -> {target}", flush=True)
    snapshot_download(repo_id=REPO, revision=REVISION, local_dir=target, allow_patterns=ALLOW)
    ok = True
    for fname, want in EXPECTED.items():
        p = os.path.join(target, fname)
        if not os.path.isfile(p):
            print(f"MISSING {fname}", flush=True); ok = False; continue
        got = sha256(p)
        match = got == want
        ok = ok and match
        print(f"{'OK ' if match else 'MISMATCH'} {fname} sha256={got[:16]}… expected={want[:16]}…", flush=True)
    if not ok:
        print("SUPPLY-CHAIN VERIFICATION FAILED — refusing. Deleting suspect artifacts.", flush=True)
        for fname in EXPECTED:
            try:
                os.remove(os.path.join(target, fname))
            except OSError:
                pass
        sys.exit(2)
    print("VERIFIED. model dir:", target, flush=True)
    print(target)


if __name__ == "__main__":
    main()
