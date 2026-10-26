#!/bin/sh
# Upgrades the omp binary in place. Run as root by /etc/cron.d/omp-auto-update
# (every 4 hours); safe to run by hand. Keeps one backup and restores it if the
# upgraded binary cannot report its version. A concurrent run exits quietly.
set -eu

export HOME=/root
OMP_BIN="${OMP_BIN:-/usr/local/bin/omp}"
LOCK_DIR="${OMP_AUTO_UPDATE_LOCK_DIR:-/run/omp-auto-update.lock}"

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) omp-auto-update: $*"
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # Reclaim a lock left by a run that was killed (e.g. container stop).
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
    mkdir "$LOCK_DIR" 2>/dev/null || { log "another run holds the lock, skipping"; exit 0; }
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

before="$("$OMP_BIN" --version 2>&1 | head -n 1)" || before="unknown"
backup="$OMP_BIN.prev"
cp -p "$OMP_BIN" "$backup"

if ! timeout 600 "$OMP_BIN" update; then
    log "omp update failed (still $before)"
    rm -f "$backup"
    exit 1
fi

if ! after="$("$OMP_BIN" --version 2>&1 | head -n 1)"; then
    log "upgraded binary is broken, restoring $before"
    mv -f "$backup" "$OMP_BIN"
    exit 1
fi

rm -f "$backup"
if [ "$before" = "$after" ]; then
    log "already current ($after)"
else
    log "upgraded $before -> $after"
fi
