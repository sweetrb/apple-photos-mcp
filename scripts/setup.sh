#!/usr/bin/env bash
#
# Create a Python venv and install osxphotos.
# Run via: npm run setup
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_ROOT/venv"

echo "==> Setting up Python venv in $VENV_DIR"

PYTHON=""
for cmd in python3 python; do
  if command -v "$cmd" &>/dev/null; then
    PYTHON="$cmd"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "ERROR: Python 3 not found. Install Python 3 first." >&2
  exit 1
fi

echo "    Using: $PYTHON ($($PYTHON --version))"

if [ ! -d "$VENV_DIR" ]; then
  echo "==> Creating virtual environment..."
  "$PYTHON" -m venv "$VENV_DIR"
else
  echo "    Venv already exists, updating..."
fi

echo "==> Installing osxphotos..."
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r "$PROJECT_ROOT/requirements.txt" -q

echo "==> Verifying installation..."
"$VENV_DIR/bin/python3" -c "import osxphotos; print(f'    osxphotos {osxphotos.__version__} installed')"

echo "==> Done! Python venv ready."
