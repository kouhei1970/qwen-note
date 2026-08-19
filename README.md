# ローカル Qwen3.8 27B でコーディングエージェント — Ollama(MLX) + Qwen Code の私のおすすめ設定（M3 Ultra 実測付き）

2026-08 時点で、私のマシンで qwen3.8 がコーディングエージェントとして順調に動くようになった設定と、そこに至るまでに踏んだ問題を共有します。設定・スクリプトの実体は `configs/` にあります。

Web 版（GitHub Pages）: https://kouhei1970.github.io/qwen-note/

## 目次

1. [TL;DR](#1-tldr)
2. [環境](#2-環境)
3. [全体像](#3-全体像)
4. [Ollama 側の設定](#4-ollama-側の設定)
5. [Qwen Code 側の設定](#5-qwen-code-側の設定)
6. [QWEN.md（モデルへのグローバル指示）](#6-qwenmdモデルへのグローバル指示)
7. [実測性能とキャッシュの挙動](#7-実測性能とキャッシュの挙動)
8. [Sonnet との簡易ベンチ](#8-sonnet-との簡易ベンチ)
9. [運用ノウハウ](#9-運用ノウハウ)
10. [セットアップ手順（まとめ）](#10-セットアップ手順まとめ)
11. [リポジトリ構成](#11-リポジトリ構成)
12. [ライセンス / 免責](#12-ライセンス--免責)

## 1. TL;DR

- コンテキスト長（`num_ctx`）は Ollama の Modelfile でしか固定できません。私は `98304` に固定しています。OpenAI 互換 `/v1` 経由では `options` を渡せず、かつ Ollama.app は `OLLAMA_CONTEXT_LENGTH` を VRAM から自動算出した値（このマシンでは `262144`）で上書きしてしまうためです。
- Ollama 環境変数は `OLLAMA_KEEP_ALIVE=8h`（prefix cache を捨てさせない）と `OLLAMA_NUM_PARALLEL=1`（コンテキストを 1 エージェントに全量割り当てる）を LaunchAgent で永続化しています。
- Qwen Code 側の HTTP タイムアウトは既定 120 秒のままだと大きめの会話で確実に詰まります。`timeout` を 30 分（`1800000`）に伸ばし、`contextWindowSize` を Modelfile の `num_ctx` と同じ `98304` に一致させています。
- `contextWindowSize` を下げて安全マージンを取ろうとした結果、逆に壊れました。qwen-code 内部の圧縮・出力クランプのロジックと衝突したためです（詳細は 5 章）。
- thinking を切るパラメータは `extra_body.reasoning_effort: "none"` だけが効きました。`enable_thinking: false` や `think: false` など、他に試した候補はすべて効きませんでした。
- `~/.qwen/QWEN.md`（グローバル指示）に「既存ファイルを `write_file` で丸ごと書き換えない」などの編集鉄則を入れたところ、インデント崩れによる構文破壊がほぼ止まりました。

## 2. 環境

| 項目 | 内容 |
|---|---|
| マシン | Mac Studio, Apple M3 Ultra, ユニファイドメモリ 512 GB |
| OS | macOS 26.5.2 (Darwin 25.5.0) |
| Ollama | 0.32.13（Ollama.app、MLX ランナー。ログ: `MLX engine initialized "MLX version"=0.32.0-190-g3abd0fd device=gpu`） |
| Qwen Code CLI | `qwen` 0.21.12（`npm install -g @qwen-code/qwen-code` で導入。`/opt/homebrew/bin/qwen` → `node_modules/@qwen-code/qwen-code/cli-entry.js`） |

使用モデル（`ollama list`）:

| モデル | ID | サイズ | 備考 |
|---|---|---|---|
| `qwen3.8-coder:27b` | `a4fd993c80f2` | 18 GB | 自作カスタム（本記事のメイン。詳細は 4-2 章）。ロード時 32 GB, 100% GPU, CONTEXT 98304 |
| `qwen3.8:27b-mlx` | `5642e97495e1` | 18 GB | 公式（ollama.com）ベース。architecture `qwen3_5`, 27.8B, context length 262144, quantization nvfp4, capabilities: completion / vision / tools / thinking |
| `qwen3.6:35b-mlx` | `1b50c6fdc2d4` | 21 GB | 比較用。architecture `qwen3_5_moe`, 35.1B MoE, quantization nvfp4 |

`qwen3.8:27b-mlx` のベース既定パラメータ（`ollama show qwen3.8:27b-mlx`）: `temperature 1`, `top_p 0.95`, `top_k 20`, `min_p 0`, `presence_penalty 0`, `repeat_penalty 1`。

## 3. 全体像

エージェントからの 1 リクエストは次の経路を通ります。

```
Qwen Code (CLI) --OpenAI互換 /v1--> Ollama.app (MLX ランナー) --> qwen3.8-coder:27b
```

この経路の途中に、決めごとが 3 つの層に分かれて存在します。どこで何を固定するかを間違えると、片方の設定がもう片方に上書きされて「設定したのに反映されない」状態になります。

| 層 | 決めること | 設定場所 |
|---|---|---|
| Ollama 環境変数 | KEEP_ALIVE, MAX_LOADED_MODELS, NUM_PARALLEL, FLASH_ATTENTION | LaunchAgent 経由の `launchctl setenv`（4-1 章） |
| Modelfile | `num_ctx`（コンテキスト長固定）とサンプリング既定値 | `ollama create`（4-2 章） |
| Qwen Code `settings.json` | HTTP timeout, `contextWindowSize`, `samplingParams`, `reasoning_effort`, `max_tokens` など | `~/.qwen/settings.json`（5 章） |

特に押さえておきたい 2 点です。

- **`num_ctx` は Modelfile でしか固定できません。** OpenAI 互換 `/v1` 経由のリクエストには Ollama の `options` を乗せられないため、クライアント側からコンテキスト長を指定する手段がありません。
- **Ollama.app は `OLLAMA_CONTEXT_LENGTH` を自動算出した値で上書きします。** このマシンでは VRAM から `262144` が算出され、`launchctl setenv OLLAMA_CONTEXT_LENGTH ...` を指定しても反映されません（サーバログでも `OLLAMA_CONTEXT_LENGTH:262144` のままでした）。Modelfile の `PARAMETER num_ctx` はこれより優先されるため、実質的にコンテキスト長を固定する唯一の手段になっています。

## 4. Ollama 側の設定

### 4-1. 環境変数（LaunchAgent + スクリプト）

`~/Library/LaunchAgents/com.kouhei.ollama-env.plist` が `RunAtLoad` で `~/.local/bin/ollama-tuned-env.sh` を実行し（`/bin/sh`）、ログイン時に環境変数を設定したうえで Ollama.app を再起動します。ログは `/tmp/ollama-tuned-env.log` です。

```sh
#!/bin/sh
# qwen-code + ollama(MLX) 向けチューニング環境変数をログイン時に設定し、
# Ollama.app に確実に読ませるため一度だけ再起動する。
launchctl setenv OLLAMA_KEEP_ALIVE 8h
launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
launchctl setenv OLLAMA_NUM_PARALLEL 1
launchctl setenv OLLAMA_FLASH_ATTENTION 1

# 注意: OLLAMA_CONTEXT_LENGTH は Ollama.app が VRAM から自動算出した値で上書きするため
# ここでは設定しない。コンテキスト長は Modelfile の PARAMETER num_ctx で固定している
# （qwen3.8-coder:27b = 98304）。

# 既に起動済みなら env を読み直させるために再起動
if pgrep -f "Ollama.app" >/dev/null 2>&1; then
  osascript -e 'quit app "Ollama"' >/dev/null 2>&1
  sleep 4
  pkill -f "Ollama.app" >/dev/null 2>&1
  sleep 2
fi
open -a Ollama >/dev/null 2>&1
```

各変数の意図です。

| 変数 | 値 | 意図 |
|---|---|---|
| `OLLAMA_KEEP_ALIVE` | `8h` | モデルを常駐させ、prefix cache を捨てさせない（再 prefill を避ける） |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | 他モデルのロードで 27B モデルが追い出されないようにする |
| `OLLAMA_NUM_PARALLEL` | `1` | コンテキストをスロット分割せず、1 エージェントに全量を割り当てる |
| `OLLAMA_FLASH_ATTENTION` | `1` | llama.cpp ランナー向けの指定。MLX ランナーでは無視される |

導入は `launchctl load ~/Library/LaunchAgents/com.kouhei.ollama-env.plist`（または再ログイン）。確認は `launchctl getenv OLLAMA_KEEP_ALIVE` で `8h` が返れば反映されています。サーバログでも次の形で反映を確認しています。

```
OLLAMA_KEEP_ALIVE:8h0m0s OLLAMA_MAX_LOADED_MODELS:1 OLLAMA_NUM_PARALLEL:1 OLLAMA_FLASH_ATTENTION:true OLLAMA_CONTEXT_LENGTH:262144
```

`OLLAMA_CONTEXT_LENGTH` だけは Ollama.app の自動値のまま変わっていません。だからこそコンテキスト長は Modelfile 側で固定しています。Ollama.app 側の GUI 設定（Expose 等）はいじっていません。ログ場所は `~/.ollama/logs/server.log` です。

### 4-2. カスタムモデル Modelfile

`qwen3.8:27b-mlx` をベースに、次の Modelfile でカスタムモデル `qwen3.8-coder:27b` を作っています。

```
FROM qwen3.8:27b-mlx
PARAMETER num_ctx 98304
PARAMETER temperature 0.7
PARAMETER top_p 0.8
PARAMETER top_k 20
PARAMETER min_p 0
PARAMETER repeat_penalty 1.05
PARAMETER presence_penalty 0
```

作成コマンド:

```sh
ollama create qwen3.8-coder:27b -f Modelfile
```

確認コマンド:

```sh
ollama show qwen3.8-coder:27b
```

ベースからの変更点とその理由です。

| パラメータ | ベース | カスタム | 理由 |
|---|---|---|---|
| `num_ctx` | （未指定、実行時 262144） | `98304` | 3 章の理由により Modelfile でしか固定できない。262144 のままロードすると KV キャッシュ確保が巨大になるため、実用上限として 98304 に固定した |
| `temperature` | `1` | `0.7` | Qwen3 系で公式に推奨されている non-thinking 用サンプリング値。thinking を切ってコーディングに使うためこちらを採用 |
| `top_p` | `0.95` | `0.8` | 同上 |
| `top_k` | `20` | `20`（変更なし） | 同上 |
| `min_p` | `0` | `0`（変更なし） | 同上 |
| `repeat_penalty` | `1` | `1.05` | 軽い反復抑止。強くしすぎるとコードが壊れるため 1.05 に留めた |

なお qwen-code は `samplingParams`（`temperature` / `top_p`）をリクエストに載せて上書きしてくるため、Modelfile 側と `settings.json` 側で同じ値（`0.7` / `0.8`）に揃えています。`num_ctx` だけは Modelfile が唯一の指定手段です。

## 5. Qwen Code 側の設定

`~/.qwen/settings.json` の要点です（公開用に整理した版を `configs/qwen/settings.json` に置いています。差分は 11 章参照）。

| 項目 | 値 | 理由 |
|---|---|---|
| `security.auth.selectedType` | `"openai"` | OpenAI 互換 API として Ollama に接続する |
| `env.QWEN_CUSTOM_API_KEY_...`（127.0.0.1 用） | `"ollama"` | ダミー鍵。Ollama は認証不要だが空文字だと弾かれるため任意文字列を入れている |
| `env.QWEN_STREAM_IDLE_TIMEOUT_MS` | `"900000"`（既定 240 秒 → 15 分） | 長い prefill 中にストリームが無応答扱いで切られないようにする |
| `env.QWEN_STREAM_MAX_LIFETIME_MS` | `"3600000"`（既定 15 分 → 60 分） | 同上 |
| `context.autoCompactThreshold` | `0.75` | `98304 × 0.75 ≒ 73k` で自動圧縮を開始する |
| `generationConfig.timeout`（主力モデル） | `1800000`（30 分） | 5-1 章参照 |
| `generationConfig.maxRetries` | `1` | 5-1 章参照 |
| `generationConfig.contextWindowSize` | `98304` | Modelfile の `num_ctx` と一致させる。5-2 章参照 |
| `generationConfig.samplingParams` | `{temperature: 0.7, top_p: 0.8, max_tokens: 32768}` | Modelfile と揃える。`max_tokens` は大きなファイル生成が途中で途切れないようにするため |
| `generationConfig.extra_body.reasoning_effort` | `"none"` | 5-3 章参照 |
| `model.maxSessionTurns` / `maxWallTimeSeconds` / `maxToolCalls` | `200` / `3600` / `500` | 自律実行（`qwen --yolo`）の暴走を止める上限 |
| `general.enableAutoUpdate` | `false` | 更新で挙動が変わるタイミングを自分で決めたいため |
| `ide.enabled` | `true` | — |

以下、特に手間取った 3 点を個別に書きます。

### 5-1. timeout 120 秒問題の顛末

**症状**: 2026-08-17、長めの会話（コンテキストが 5 万トークンを超えるあたり）で、サーバログに `[GIN] 500 | 1m59s` が周期的に出て、クライアント側は `Request terminated: context canceled` を繰り返すようになりました。

**原因**: qwen-code の既定 HTTP タイムアウトは 120 秒（`DEFAULT_TIMEOUT = 12e4`）です。このマシンの MLX/nvfp4 ビルドは prefill が約 340〜400 tok/s なので、5 万トークン超の会話では prefill だけで 120 秒を超えます。タイムアウトでクライアントが切断すると、Ollama 側は prefix cache を破棄し（ログに `cache miss ... matched=43007 cached=0` のような行が出る）、次のリクエストはゼロから再 prefill を始めます。これがまた 120 秒を超えて切断される、という 2 分周期のループに陥っていました。

**対策**: `generationConfig.timeout` を `1800000`（30 分）に延長し、`maxRetries` を `1` に設定したところ解消しました。

### 5-2. contextWindowSize を 32768 にして失敗した話

2026-08-17 に、安全マージンのつもりで `contextWindowSize` を `32768` に下げたことがあります。結果は逆でした。1〜2 ターンごとに自動圧縮が走るようになり、`max_tokens` が内部クランプで `4000` まで絞られ、大きめの `write_file` が黙って途中で切れる「作業が止まる」症状が出ました。

2026-08-19 に原因を特定しました。qwen-code 0.21.x は `contextWindowSize` から内部的に次のマージンを差し引いて実効の出力余地を計算しています。

- `SUMMARY_RESERVE`: 20000
- `AUTOCOMPACT_BUFFER`: 13000
- 出力クランプ余白: 10000
- `MIN_CLAMPED_OUTPUT_TOKENS`: 4000

固定分だけで 4 万トークンを超えるため、`contextWindowSize` を 32768 にすると窓のほとんどがマージンに食われ、圧縮が頻発したうえに出力が最小値の 4000 トークンに張り付いてしまいます。窓を小さくしても Ollama 側の負荷は下がらない（prefill 速度はコンテキスト長にほぼ依存しない）ので、下げる利点もありませんでした。**教訓は「`contextWindowSize` は `num_ctx` と必ず一致させる。`num_ctx` を上げるときは `contextWindowSize` も同時に上げる」**です。

### 5-3. reasoning_effort "none" が唯一効く話

Ollama 0.32.13 の `/v1/chat/completions` で Qwen3 系の thinking を切るパラメータを探しました。2026-08-17 の実測で、効いたのは `extra_body.reasoning_effort: "none"` だけでした。

効かなかったもの:

- `enable_thinking: false`（トップレベル指定・`extra_body` 経由のどちらも）
- `chat_template_kwargs: {enable_thinking: false}`
- `think: false`（ネイティブ `/api` では効くが `/v1` では無視される）
- `reasoning_effort: "low"`（トークン数がベースラインと変わらなかった）

`/v1` エンドポイントは未知のフィールドを黙って捨てるため、「エラーが出ない＝効いている」ではありません。検証は `usage.completion_tokens` の値か、返ってくる `reasoning_content` の長さで行う必要があります。実測では、「17*23 は?」という質問に対して `completion_tokens` が `54`（thinking あり）から `3`（`reasoning_effort: "none"`）まで減りました。

## 6. QWEN.md（モデルへのグローバル指示）

このモデルには、既存コードを逐語的に書き写す際に**行頭の空白を 1 文字余分に付ける癖**があります。`edit` 系ツールは完全一致でしか動かないため失敗し、`write_file` で全文を書き直すとその空白ずれがファイル全体に広がって構文を壊します。

2026-08-17 に、この癖を定量的に確認しました。temperature `0.2` / `0.4` / `0.7` / `1.0` × 編集タスク 5 種 × 3 回 = 60 リクエストで検証したところ、成功率は `80% / 80% / 80% / 87%` で温度による有意差はありませんでした。一方で失敗は複数行ブロック置換に集中しており（12 回中 1 回成功）、単一行編集は 48 回中 48 回成功しています。差分の典型は `'    ]'` が `'     ]'` になるような、閉じ括弧行の空白 1 個のずれでした。`write_file` による全文置換では 1 ファイルにつき 6 箇所が壊れて `IndentationError` になったにもかかわらず、モデル自身は「成功」と報告していました。

この観測をもとに `~/.qwen/QWEN.md` に次の鉄則を入れています。

1. **`write_file` で既存ファイルを丸ごと書き換えない。** 新規作成のときだけ使う。
2. **`old_string` は必要最小限、原則 1 行。** 一意にするための文脈も 2〜3 行まで。リスト・辞書・関数本体をまるごと `old_string` にしない。
3. **複数箇所を直すときは `edit` を複数回に分ける。**
4. `edit` が「見つからない」で失敗したら、同じ文字列で再試行しない。`read_file` で読み直し、より短い 1 行の `old_string` にする。

導入効果は明確でした。同一タスクで比較したところ、導入前は **5 分 19 秒、6 箇所破損、しかもモデルは成功と虚偽報告**していたのが、導入後は **57 秒、変更 1 行のみ、インデント一致**まで改善しました。

なお、フォーマッタ（ruff / black / prettier / eslint、いずれも Homebrew または `npm -g` で導入済み）は構文が壊れたファイルを直せません。「`write_file` 全文置換禁止」がこの問題への本質的な防御であり、フォーマッタはその後段の仕上げに過ぎない、というのが今回の結論です。QWEN.md にはこの他に、作業の進め方（`todo_write` での手順化）、終了条件（未検証の明記、同じ確認を 3 回以上繰り返さない、無変更ターンが 5 回続いたら停止）、編集後の検証手順（構文チェック → 直す → フォーマッタの順序厳守）、外部 API の同時接続数（6 程度）、報告時の姿勢（前置きなし、未検証・未達を正直に書く）を定めています。全文は `configs/qwen/QWEN.md` にあります。

## 7. 実測性能とキャッシュの挙動

このマシン・`qwen3.8-coder:27b`（nvfp4, MLX）での実測です。

- **prefill**: 約 340〜400 tok/s
- **decode**: 約 40〜70 tok/s
- コンテキスト長を変えても prefill 速度はほぼ変わりません。
- **cold prefill の所要時間**: 20k トークンで約 1 分、32k で約 80 秒、65k で約 3 分。

### prefix cache のログの読み方

Ollama のログには次のような行が出ます。

```
cache hit total=58081 matched=57916 cached=57883
```

私の理解では、`total` がリクエストの総トークン数、`matched` が既存キャッシュと一致した長さ、`cached` が実際にキャッシュから復元できた長さです。3 つが近い値であるほど再 prefill を避けられていることになり、`cached=0` なら全量を prefill し直しています。逆に次のような行が出たら、キャッシュが全破棄されたと考えて疑ってください。

```
failed to restore cache, freeing all caches
```

**08-17 と 08-19 の観測を両方正直に書きます。** 2026-08-17 時点では `cached=32767` で頭打ちになり、その直後に `failed to restore cache, freeing all caches` が出る挙動が見えていました（見かけ上「32K で頭打ち」）。その後、`num_ctx` を `98304` に固定したカスタムモデル `qwen3.8-coder:27b` に切り替えたところ、2026-08-19 のログでは `cache hit total=58081 matched=57916 cached=57883` のように 5 万〜6.5 万トークン台でもヒットが継続し、最大で `cached=65380` を観測しています。ただし `failed to restore cache` は 08-19 も offset 32313 / 33833 / 37791 などで数回出ており、圧縮の直後などにキャッシュが全破棄されることは今も時々起きます。**長時間セッションで急に応答が遅くなったときは、まずこのログを見る**というのが今の運用です。

### 並列について

`OLLAMA_NUM_PARALLEL=1` にしているため並列実行はできません。複数の `qwen` プロセスを同時に走らせると GPU を奪い合って極端に遅くなります。プロセスを止めるときは `pkill -f "qwen-code/cli.js"` を使います。`pkill -f "qwen --yolo"` はプロセス名に一致せず取り逃すため注意が必要です。

## 8. Sonnet との簡易ベンチ

2026-08-17、`qwen3.8-coder:27b` と Claude Sonnet の subagent とで、Python の課題 4 種（隠しテスト計 61 項目）を解かせて比較しました。

| 課題 | qwen3.8-coder:27b | Sonnet subagent | 倍率 |
|---|---|---|---|
| intervals | 51.0 秒 | 26.1 秒 | 2.0x |
| bugfix | 313.2 秒 | 27.3 秒 | 11.5x |
| logparse | 91.7 秒 | 64.8 秒 | 1.4x |
| shipping | 130.8 秒 | 67.2 秒 | 1.9x |
| 合計（逐次実行） | 586.7 秒 | 185.4 秒 | 3.2x |

正答率はどちらも 61/61（隠しテストに対して天井に達しており、課題自体が易しかったことが影響しています）。Sonnet は 4 本を並列実行すれば 67 秒でした。

テストでは拾えなかった品質差もありました。qwen はリファクタ課題で仕様逸脱が 2 点ありました（丸め順序、エラー判定順序の入れ替え）。また bugfix の 313 秒は外れ値で、正解にたどり着いた後も検証ループを回し続けていたことが原因です。

**このベンチの限界**: 各課題 1 回のみの実行で分散は測定していません。ツールセットも qwen と Sonnet subagent とで異なります。参考値以上のものとして扱わないでください。

## 9. 運用ノウハウ

- **段階分割セッション**: 大きめの実装は 1 セッション 1 目的で分割します（S1 = 純粋関数、S2 = サーバ、S3 = API、S4 = フロント、など）。他ファイルを読ませず、関数名・引数・期待値といった契約は指示文に直接書きます。期待値は自分で先に実測してから渡します。
- **検証範囲を絞る**: 検証はモデルが実行できるものだけを合格条件にします。node や curl だけで完結する段階では `--allowed-mcp-server-names "none"` で MCP を切り、コンテキストを節約します。
- **長時間実行**: `nohup qwen --yolo ... &` でバックグラウンド実行します。
- **プロセス停止**: `pkill -f "qwen-code/cli.js"` を使います（`pkill -f "qwen --yolo"` は取り逃します）。
- **効果**: 一括実装を試みたときは 109 分かけて未完に終わりました。段階分割にしたところ各セッションのコンテキストは 23k〜30k に収まり、`cached=30626` のような完全ヒットも観測しています。

## 10. セットアップ手順（まとめ）

1. Ollama.app をインストールします（0.32.12 以上、MLX ランナー対応）。ベースモデルを取得します。
   ```sh
   ollama pull qwen3.8:27b-mlx
   ```
2. `configs/ollama/Modelfile.qwen3.8-coder` を保存し、カスタムモデルを作ります。`num_ctx 98304` が反映されていることを確認します。
   ```sh
   ollama create qwen3.8-coder:27b -f Modelfile.qwen3.8-coder
   ollama show qwen3.8-coder:27b
   ```
3. `configs/ollama/ollama-tuned-env.sh` を `~/.local/bin/` に置いて実行権限を付け、`configs/ollama/com.kouhei.ollama-env.plist`（パスは自分のユーザ名に書き換える）を `~/Library/LaunchAgents/` に置いて読み込みます。
   ```sh
   cp ollama-tuned-env.sh ~/.local/bin/ && chmod +x ~/.local/bin/ollama-tuned-env.sh
   cp com.kouhei.ollama-env.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.kouhei.ollama-env.plist
   ```
4. Qwen Code を入れます。
   ```sh
   npm install -g @qwen-code/qwen-code
   ```
   `configs/qwen/settings.json` と `configs/qwen/QWEN.md` を `~/.qwen/` に配置します（このマシンでは `npm -g` 経由で導入し、`/opt/homebrew/bin/qwen` から `node_modules/@qwen-code/qwen-code/cli-entry.js` を実行する構成になっています）。
5. `qwen` を起動し、`/model` で `qwen3.8-coder:27b (ollama MLX / tuned, no-think)` を選びます。
6. 動作確認します。
   ```sh
   curl http://127.0.0.1:11434/v1/chat/completions -d '{
     "model": "qwen3.8-coder:27b",
     "messages": [{"role": "user", "content": "17*23 は?"}],
     "reasoning_effort": "none"
   }'
   ```
   `usage.completion_tokens` が一桁〜十数トークンなら、thinking オフが効いています。

## 11. リポジトリ構成

```
configs/
├── README.md                          各ファイルの配置先と導入コマンドの一覧
├── ollama/
│   ├── Modelfile.qwen3.8-coder        カスタムモデル定義（4-2 章）
│   ├── ollama-tuned-env.sh            環境変数設定スクリプト（4-1 章）
│   └── com.kouhei.ollama-env.plist    上記スクリプトを起動する LaunchAgent
└── qwen/
    ├── settings.json                  Qwen Code 設定の公開版（5 章）
    └── QWEN.md                        モデルへのグローバル指示（6 章）
```

そのほか `site/`（テンプレート・CSS・SNS カード画像）、`scripts/build-site.mjs`、`.github/workflows/pages.yml` は GitHub Pages 用のビルド一式です。この README.md を単一ソースとして HTML 化し、`main` への push で自動デプロイしています。

各ファイルへのリンク: [configs/README.md](configs/README.md) / [Modelfile.qwen3.8-coder](configs/ollama/Modelfile.qwen3.8-coder) / [ollama-tuned-env.sh](configs/ollama/ollama-tuned-env.sh) / [com.kouhei.ollama-env.plist](configs/ollama/com.kouhei.ollama-env.plist) / [settings.json](configs/qwen/settings.json) / [QWEN.md](configs/qwen/QWEN.md)

`configs/qwen/settings.json` は実物 `~/.qwen/settings.json` を元にした公開版で、以下の点を整理しています。

- `permissions.allow` の自動許可リストは削除しています（作業中に蓄積した雑多なコマンドパターンのため、そのまま公開する価値がありません）。
- `ui.feedbackLastShownTimestamp` / `ide.hasSeenNudge` / `ui.autoModeAcknowledged` といった状態値は削除しています。
- LAN 上の LM Studio ホストの IP アドレスはプレースホルダ `LM_STUDIO_HOST` に置き換えています。対応する API キーの環境変数名も `QWEN_CUSTOM_API_KEY_LM_STUDIO` に置き換えています。
- 未使用だった `localhost:11434` 用の API キーエントリは削除しています。

JSON としての妥当性は `python3 -m json.tool` で検証済みです。

## 12. ライセンス / 免責

- `configs/` 以下の設定ファイル・スクリプトは MIT ライセンスです（`LICENSE` 参照）。
- 本文（README.md および GitHub Pages 版の記事）は CC BY 4.0 とします。
- 本記事の数値はすべて、2026-08-17 および 2026-08-19 に、このマシン（Mac Studio, Apple M3 Ultra, 512 GB, macOS 26.5.2, Ollama 0.32.13, Qwen Code 0.21.12）で実測したものです。ハードウェア・OS・Ollama / Qwen Code のバージョンが異なれば数値は変わります。参考値としてご利用ください。
