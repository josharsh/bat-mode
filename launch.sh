#!/bin/sh
set -eu
cd "$(dirname "$0")"
if command -v uv >/dev/null 2>&1; then
  exec uv run --project . python -m batmode "$@"
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Install Python 3.10+ or uv, then run this launcher again."
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import batmode, numpy, sounddevice' >/dev/null 2>&1; then
  .venv/bin/python -m pip install -e .
fi
exec .venv/bin/python -m batmode "$@"
