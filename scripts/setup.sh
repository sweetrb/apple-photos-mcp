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
for cmd in python3.14 python3.13 python3.12 python3.11 python3 python; do
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

# Require Python >= 3.11 (osxphotos needs >=3.10; full ISO-8601 date parsing in
# the --from-date/--to-date filters needs 3.11). macOS ships 3.9 — fail early.
if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "ERROR: Python >= 3.11 required, but '$PYTHON' is $($PYTHON --version 2>&1)." >&2
  echo "       macOS ships Python 3.9. Install a newer one, e.g.:" >&2
  echo "         brew install python@3.12     # then re-run: npm run setup" >&2
  echo "       or from https://www.python.org/downloads/" >&2
  exit 1
fi

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

# Record which requirements.txt this venv was built against, so the server can
# detect a stale venv after an update changes requirements and rebuild itself.
cp "$PROJECT_ROOT/requirements.txt" "$VENV_DIR/.deps-ok"

echo "==> Done! Python venv ready."
