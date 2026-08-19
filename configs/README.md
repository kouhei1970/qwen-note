# configs/ について

README.md 本文で解説している設定ファイルの実体です。それぞれの配置先パスと導入コマンドは以下の通りです。

| ファイル | 配置先 | 導入コマンド |
|---|---|---|
| `ollama/Modelfile.qwen3.8-coder` | 任意の作業ディレクトリ（一時的に使うだけ） | `ollama create qwen3.8-coder:27b -f ollama/Modelfile.qwen3.8-coder` |
| `ollama/ollama-tuned-env.sh` | `~/.local/bin/ollama-tuned-env.sh` | `cp ollama/ollama-tuned-env.sh ~/.local/bin/ && chmod +x ~/.local/bin/ollama-tuned-env.sh` |
| `ollama/com.kouhei.ollama-env.plist` | `~/Library/LaunchAgents/com.kouhei.ollama-env.plist` | `cp ollama/com.kouhei.ollama-env.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.kouhei.ollama-env.plist` |
| `qwen/settings.json` | `~/.qwen/settings.json` | `cp qwen/settings.json ~/.qwen/settings.json` |
| `qwen/QWEN.md` | `~/.qwen/QWEN.md` | `cp qwen/QWEN.md ~/.qwen/QWEN.md` |

## 注意

- `ollama/com.kouhei.ollama-env.plist` の中のパス（`/Users/kouhei/...`）は自分のユーザ名に書き換えてください。
- `qwen/settings.json` は公開用に整理してあります。実物との差分は README.md の「Qwen Code 側の設定」節を参照してください（LAN 上の LM Studio ホストは `LM_STUDIO_HOST` というプレースホルダに置き換え済みです）。使う場合は自分の環境の値に書き換えてください。
- `qwen/settings.json` の `env` に入っている API キーはすべてダミー文字列です（Ollama / LM Studio はどちらも認証不要ですが、空文字だと qwen-code に弾かれるため）。
