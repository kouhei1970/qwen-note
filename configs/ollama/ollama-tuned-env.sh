#!/bin/sh
# qwen-code + ollama(MLX) 向けチューニング環境変数をログイン時に設定し、
# Ollama.app に確実に読ませるため一度だけ再起動する。
# 設定意図:
#   KEEP_ALIVE=8h        モデルを常駐させ prefix cache を捨てさせない（再prefill 回避）
#   MAX_LOADED_MODELS=1  他モデルのロードで 27b を追い出さない
#   NUM_PARALLEL=1       コンテキストをスロット分割せず 1 エージェントに全量割り当て
#   FLASH_ATTENTION=1    llama.cpp ランナー用（MLX ランナーでは無視される）
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
