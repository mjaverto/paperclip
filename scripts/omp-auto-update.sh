#!/bin/sh
# Upgrades the omp binary in place. Run as root by /etc/cron.d/omp-auto-update
# (every 4 hours); safe to run by hand. Keeps one backup and restores it when
# `omp update` fails or the upgraded binary cannot report its version when run
# as the unprivileged agent user. A concurrent run exits quietly. Integrity of
# the download is whatever `omp update` itself verifies; this script adds none.
set -u

export HOME=/root
OMP_BIN="${OMP_BIN:-/usr/local/bin/omp}"
LOCK_FILE="${OMP_AUTO_UPDATE_LOCK_FILE:-/run/omp-auto-update.lock}"
AGENT_USER="${OMP_AUTO_UPDATE_AGENT_USER:-node}"

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) omp-auto-update: $*"
}

# Prints the first line of `omp --version`; fails when omp fails or prints nothing.
# $@ is an optional command prefix (e.g. gosu node) so the check can run unprivileged.
omp_version() {
    out="$(timeout 60 "$@" "$OMP_BIN" --version 2>&1)" || return 1
    out="$(printf '%s\n' "$out" | head -n 1)"
    [ -n "$out" ] || return 1
    printf '%s\n' "$out"
}

# Kernel-held lock: released when this process exits, however it exits.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "another run holds the lock, skipping"
    exit 0
fi

before="$(omp_version)" || before="unknown"
backup="$OMP_BIN.prev"
cp -p "$OMP_BIN" "$backup" || { log "cannot back up $OMP_BIN"; exit 1; }

restore() {
    mv -f "$backup" "$OMP_BIN"
}

if ! timeout 600 "$OMP_BIN" update; then
    log "omp update failed, restoring $before"
    restore
    exit 1
fi

if ! after="$(omp_version gosu "$AGENT_USER")"; then
    log "upgraded binary does not run as $AGENT_USER, restoring $before"
    restore
    exit 1
fi

rm -f "$backup"
if [ "$before" = "$after" ]; then
    log "already current ($after)"
else
    log "upgraded $before -> $after"
fi
