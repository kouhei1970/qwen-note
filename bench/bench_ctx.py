#!/usr/bin/env python3
"""num_ctx / 文脈長 マイクロベンチ（Ollama ネイティブ /api/generate）
  シリーズ1 (alloc): プロンプト約4Kを固定し num_ctx だけ変える → 確保サイズの影響
  シリーズ2 (fill) : num_ctx=262144 を固定し、実プロンプト長 8K..128K を変える → 実文脈長の影響
出力: JSON lines を results.jsonl に、要約を stdout に。
"""
import json, time, glob, sys, urllib.request, subprocess, os
MODEL = "qwen3.8-coder:27b"
URL = "http://127.0.0.1:11434/api/generate"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bench_ctx_results.jsonl")

# --- コーパス: highlight.js の言語定義 JS を連結（コード寄りの現実的な入力）---
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = sorted(glob.glob(os.path.join(REPO, "node_modules/highlight.js/lib/languages/*.js")))  # npm install 済みであること
corpus = ""
for f in files:
    corpus += f"\n// ===== {os.path.basename(f)} =====\n" + open(f, encoding="utf-8", errors="ignore").read()
    if len(corpus) > 1_200_000: break
print(f"corpus chars={len(corpus):,} files={len(files)}", flush=True)

def call(prompt, num_ctx, num_predict=200, tag=""):
    body = {"model": MODEL, "prompt": prompt, "stream": False, "think": False,
            "keep_alive": "8h",
            "options": {"num_ctx": num_ctx, "num_predict": num_predict, "temperature": 0}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=3600) as r:
        d = json.loads(r.read())
    wall = time.time() - t0
    pe, ped = d.get("prompt_eval_count", 0), d.get("prompt_eval_duration", 1) or 1
    ec, ed = d.get("eval_count", 0), d.get("eval_duration", 1) or 1
    ld = d.get("load_duration", 0) / 1e9
    ps = subprocess.run(["ollama", "ps"], capture_output=True, text=True).stdout.strip().splitlines()
    size = next((l.split()[2] + " " + l.split()[3] for l in ps if l.startswith(MODEL)), "?")
    rec = {"tag": tag, "num_ctx": num_ctx, "prompt_tokens": pe, "prefill_tps": round(pe / (ped / 1e9), 1),
           "gen_tokens": ec, "decode_tps": round(ec / (ed / 1e9), 2), "load_s": round(ld, 1),
           "prefill_s": round(ped / 1e9, 1), "wall_s": round(wall, 1), "loaded_size": size}
    print(json.dumps(rec, ensure_ascii=False), flush=True)
    with open(OUT, "a") as fo: fo.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec

def slice_prompt(target_tokens, chars_per_tok, offset):
    n = int(target_tokens * chars_per_tok)
    start = offset % max(1, len(corpus) - n)
    return corpus[start:start + n] + "\n\nDescribe in one sentence what kind of code the text above is."

# --- キャリブレーション: chars/token を実測 ---
cal = call(corpus[:12000] + "\n\nOne sentence: what is this?", 16384, 16, tag="calib")
cpt = 12000 / max(1, cal["prompt_tokens"] - 12)
print(f"chars_per_token ≈ {cpt:.2f}", flush=True)

# --- シリーズ1: 確保サイズだけ変える（プロンプト ~4K 固定、毎回別オフセット）---
for i, nc in enumerate([16384, 32768, 65536, 98304, 131072, 262144]):
    call(slice_prompt(4000, cpt, 20000 * (i + 1)), nc, 200, tag=f"alloc-{nc}")

# --- シリーズ2: 実文脈長を変える（num_ctx=262144 固定）---
for i, fill in enumerate([8000, 32000, 64000, 96000, 128000]):
    call(slice_prompt(fill, cpt, 150000 * (i + 1) + 7777), 262144, 200, tag=f"fill-{fill}")

# --- 後片付け: 運用状態（Modelfile 既定 num_ctx=98304）に戻す ---
body = {"model": MODEL, "prompt": "ok", "stream": False, "think": False, "keep_alive": "8h", "options": {"num_predict": 1}}
urllib.request.urlopen(urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}), timeout=600).read()
print("DONE restored default load", flush=True)
