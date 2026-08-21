#!/usr/bin/env bash
# Set up an MLX server for Blaude on Apple Silicon.
#
# Why MLX over Ollama for the big model:
#   * it uses the model's own context length instead of a daemon-wide cap
#   * unified memory means no separate VRAM budget
#   * quantised weights load straight from Hugging Face
#
# This downloads several GB. Nothing here runs automatically.
set -euo pipefail

MODEL="${1:-}"
PORT="${2:-8081}"

if [[ -z "$MODEL" ]]; then
  cat <<'USAGE'
usage: scripts/setup-mlx.sh <hf-model-id> [port]

Pick a quantisation that leaves room for the KV cache and the rest of your
machine. On a 48 GB Mac, a 27B-class model at 4-6 bit is the sweet spot:

  4-bit  ~16 GB   plenty of headroom for long contexts
  5-bit  ~20 GB   good balance
  6-bit  ~24 GB   best quality that still leaves room
  8-bit  ~29 GB   works, but the KV cache will squeeze
  bf16   ~54 GB   does not fit

Find current MLX conversions by searching Hugging Face for the model name plus
"mlx" — the mlx-community org publishes most of them. Verify the repo id exists
before running this; model names change faster than scripts do.

example:
  scripts/setup-mlx.sh mlx-community/Qwen3-27B-4bit 8081
USAGE
  exit 1
fi

command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/"; exit 1; }

VENV="${HOME}/.blaude/mlx-venv"
echo "==> creating venv at ${VENV}"
uv venv "$VENV" --python 3.12
# shellcheck disable=SC1091
source "${VENV}/bin/activate"

echo "==> installing mlx-lm"
uv pip install --upgrade mlx-lm

echo "==> starting the server on port ${PORT} (first run downloads the weights)"
echo "    model: ${MODEL}"
echo
echo "    Leave this running, then point Blaude at it:"
echo "      blaude init"
echo "      # in ~/.blaude/config.json set:"
echo "      #   models.blaude = { backend: 'mlx', model: '${MODEL}', maxContext: 131072 }"
echo "      #   backends.mlx.baseUrl = 'http://127.0.0.1:${PORT}/v1'"
echo "      blaude doctor"
echo
exec mlx_lm.server --model "$MODEL" --port "$PORT" --host 127.0.0.1
