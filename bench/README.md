# bench/ — num_ctx / 文脈長マイクロベンチ

README 7 章「num_ctx と実文脈長が速度に与える影響」の実測に使ったスクリプトと生データです。

- `bench_ctx.py` — Ollama ネイティブ `/api/generate` に `options.num_ctx` と埋め草プロンプト（`node_modules/highlight.js` の言語定義 JS を連結したコード）を渡し、
  - シリーズ 1（`alloc-*`）: プロンプト約 4K 固定で `num_ctx` を 16384〜262144 に変える
  - シリーズ 2（`fill-*`）: `num_ctx` 262144 固定で実プロンプト長を 8K〜128K に変える
  
  を順に実行し、`prompt_eval_count / prompt_eval_duration`（prefill tok/s）と `eval_count / eval_duration`（decode tok/s）を記録します。最後に既定状態（Modelfile の num_ctx）でモデルを再ロードします。
- `bench_ctx_results.jsonl` — 2026-08-19 16:18–16:39 に M3 Ultra 512GB / Ollama 0.32.13 / `qwen3.8-coder:27b` で取った生データ。

実行方法（リポジトリ直下で `npm install` 済みであること。所要約 20 分、GPU を占有し、Ollama の prefix cache は消えます）:

```sh
python3 bench/bench_ctx.py
```

注意: `think: false`・`temperature 0`・`num_predict 200` ですが、モデルが一文で答えて早く止まるため生成トークンは 20〜60 個です。decode tok/s はその範囲での値で、±4 tok/s 程度のばらつきがあります。
