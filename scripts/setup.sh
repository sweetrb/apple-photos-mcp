#!/usr/bin/env bash
#
# Create a Python venv and install osxphotos.
# Run via: pnpm run setup
#
# Concurrency: multiple MCP server instances (one per open conversation in
# some hosts) can hit a fresh install at the same time, and each one's first
# tool call auto-runs this script. An unguarded race would interleave two
# `python -m venv` + `pip install` runs in the same directory and corrupt the
# venv. So the whole install is guarded by an atomic mkdir lock; losers wait
# (bounded) for the winner's completion marker instead of racing. The server's
# TS bootstrap holds the same lock itself and sets
# APPLE_PHOTOS_MCP_SETUP_LOCK_HELD=1 so this script doesn't deadlock trying to
# re-acquire it. The completion marker (venv/.deps-ok) is written atomically
# as the VERY LAST step, so a marker that exists always describes a fully
# installed venv.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_ROOT/venv"
LOCK_DIR="$PROJECT_ROOT/venv.setup.lock"
MARKER="$VENV_DIR/.deps-ok"

# True when the venv is complete AND was built against the current
# requirements.txt (same freshness rule the server's venvIsReady() applies).
marker_fresh() {
  [ -f "$MARKER" ] && [ -x "$VENV_DIR/bin/python3" ] \
    && cmp -s "$MARKER" "$PROJECT_ROOT/requirements.txt"
}

LOCK_ACQUIRED=0
release_lock() {
  if [ "$LOCK_ACQUIRED" = "1" ]; then
    rm -rf "$LOCK_DIR"
  fi
}

if [ "${APPLE_PHOTOS_MCP_SETUP_LOCK_HELD:-}" != "1" ]; then
  # Bounded wait for a concurrent setup, mirroring the server's setup timeout
  # (APPLE_PHOTOS_MCP_SETUP_TIMEOUT is in milliseconds; default 5 minutes).
  WAIT_MS="${APPLE_PHOTOS_MCP_SETUP_TIMEOUT:-300000}"
  case "$WAIT_MS" in *[!0-9]*) WAIT_MS=300000 ;; esac
  WAIT_SECS=$(( WAIT_MS / 1000 ))
  [ "$WAIT_SECS" -lt 1 ] && WAIT_SECS=1
  # A lock this much older than the wait window belongs to a dead process.
  STALE_SECS=$(( WAIT_SECS * 2 ))
  [ "$STALE_SECS" -lt 600 ] && STALE_SECS=600

  waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    # Age-based takeover: a holder killed mid-setup (SIGKILL) never removes
    # its lock; reclaim it once it's clearly abandoned.
    if [ -d "$LOCK_DIR" ]; then
      now=$(date +%s)
      lock_mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo "$now")
      if [ $(( now - lock_mtime )) -gt "$STALE_SECS" ]; then
        echo "    Stale setup lock (older than ${STALE_SECS}s) — taking over."
        rm -rf "$LOCK_DIR"
        continue
      fi
    fi
    # The winner writes the marker as its atomic last step — once it's fresh,
    # the venv is fully usable and there is nothing left to do.
    if marker_fresh; then
      echo "==> Venv already set up by a concurrent process. Done."
      exit 0
    fi
    if [ "$waited" -ge "$WAIT_SECS" ]; then
      echo "ERROR: Timed out after ${WAIT_SECS}s waiting for another setup process" >&2
      echo "       (lock: $LOCK_DIR). If no setup is actually running, remove that" >&2
      echo "       directory and re-run." >&2
      exit 1
    fi
    sleep 2
    waited=$(( waited + 2 ))
  done
  LOCK_ACQUIRED=1
  echo "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
  trap release_lock EXIT

  # We may have acquired the lock right after a winner finished — re-check.
  if marker_fresh; then
    echo "==> Venv already set up by a concurrent process. Done."
    exit 0
  fi
fi

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
  echo "         brew install python@3.12     # then re-run: pnpm run setup" >&2
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
# Written ATOMICALLY (tmp file + rename) as the last step: waiters treat a
# fresh marker as "venv complete", so it must never be observable half-written
# or before the install above has finished.
cp "$PROJECT_ROOT/requirements.txt" "$MARKER.tmp.$$"
mv -f "$MARKER.tmp.$$" "$MARKER"

echo "==> Done! Python venv ready."
