# Paperclip Debugging Guide

## Environment

- **Server**: `ssh openclaw` (user: `mja311`)
- **App**: Paperclip runs as a **native process** (not Docker) under `mja311`
- **DB**: `paperclip-db` Docker container, Postgres 17, credentials `paperclip/paperclip`, db `paperclip`
- **External port**: `32752` → internal `3100`
- **Agent repo (ShapeKit)**: `/home/mja311/src/shapekit-company` on openclaw (this is the live repo — edit here directly)
- **Agent repo (Probably Nothing Capital - PRO/PNC)**: `/home/mja311/.paperclip/instances/default/companies/106c5985-bd75-49df-a730-ea190e2769b2/agents/` on openclaw (if not specified, default is ShapeKit)

---

## Debugging Runbook

Work through these in order. Each section is a signal layer — start at the bottom of the stack.

### 1. Check Postgres (READ ONLY)

The fastest way to understand state. **Never write** (exception: cancelling hung runs is safe).

```bash
# Container is always named paperclip-db
sudo -u mja311 docker exec paperclip-db psql -U paperclip -d paperclip
```

Useful queries:
```sql
-- All agents and their current status
SELECT id, name, status, last_heartbeat_at FROM agents ORDER BY last_heartbeat_at DESC;

-- Missing tasks:assign permissions (agents that can't hand off work)
SELECT a.name 
FROM agents a 
LEFT JOIN principal_permission_grants p 
  ON a.id::text = p.principal_id AND p.permission_key = 'tasks:assign' 
WHERE p.id IS NULL;

-- Recent heartbeat runs with errors
SELECT a.name, h.status, h.error, h.error_code, h.exit_code, h.stderr_excerpt, h.started_at, h.finished_at
FROM heartbeat_runs h
JOIN agents a ON a.id = h.agent_id
ORDER BY h.started_at DESC NULLS LAST
LIMIT 30;

-- Failure summary per agent (last 48h)
SELECT a.name, h.status, COUNT(*) as count
FROM heartbeat_runs h
JOIN agents a ON a.id = h.agent_id
WHERE h.created_at > now() - interval '48 hours'
GROUP BY a.name, h.status
ORDER BY a.name, h.status;

-- Hung runs (running/queued with no activity for 2+ hours)
SELECT h.id, a.name, h.status, h.created_at, h.started_at
FROM heartbeat_runs h
JOIN agents a ON a.id = h.agent_id
WHERE h.status IN ('running', 'queued')
  AND h.finished_at IS NULL
  AND COALESCE(h.started_at, h.created_at) < now() - interval '2 hours'
ORDER BY h.created_at ASC;

-- Cancel a hung run (safe write)
UPDATE heartbeat_runs
SET status = 'cancelled',
    error = 'Cancelled by admin: hung run with no activity for 2+ hours',
    error_code = 'cancelled',
    finished_at = now()
WHERE id = '<run-id>'
  AND status IN ('running', 'queued');
```

> ⚠️ READ ONLY except for hung run cancellations above. No other INSERT, UPDATE, DELETE, DROP without asking Mike.

---

### 2. Check Application Logs (Web Server)

Look for 5xx errors, uncaught exceptions, startup failures. The app is a **native process**, not Docker.

```bash
# Paperclip logs (adjust path if needed)
sudo -u mja311 cat /home/mja311/.paperclip/instances/default/logs/paperclip.log | tail -200

# Or via journalctl if running as a service
sudo journalctl -u paperclip -n 200 --no-pager
```

Red flags to look for:
- `UnhandledPromiseRejection`
- `ECONNREFUSED` (DB or service unreachable)
- `500` / `502` HTTP status codes
- Port binding failures on `3100`

---

### 3. Check Agent Errors

Agent errors surface in two places: the `heartbeat_runs` table (see section 1) and `stderr_excerpt` / `stdout_excerpt` columns on each run. The Postgres queries above are faster than log grepping.

Common error patterns seen in production:

| `error_code` | Meaning | Action |
|---|---|---|
| `process_lost` | Server restarted mid-run | Usually self-heals; check for recurring pattern |
| `adapter_failed` | Tool call failed (e.g. ambiguous `oldString` in Edit) | Fix agent instructions in HEARTBEAT.md |
| `adapter_failed` + `opencode models timed out` | CPU contention starving model discovery | See [performance.md](performance.md) — check load, priorities, and timer |
| `cancelled` | Admin or watchdog cancelled | Check if task needs retry |
| `running` (stuck) | Hung run, no `finished_at` after 2h | Cancel via Postgres (see section 1) |

When you find a recurring pattern, update the relevant file in `/home/mja311/src/shapekit-company/agents/` on openclaw.

---

### 4. Self-Heal: Update ShapeKit Agent Files

When a root cause is identified in steps 1–3, update the relevant agent file in:

```
~/src/shapekit-company/agents/
```

Agent directories:
- `ceo/` — CEO agent (AGENTS.md, HEARTBEAT.md, SOUL.md, TOOLS.md)
- `founding-engineer/` — Founding Engineer agent
- `customer-success/` — Customer success agent
- `head-of-growth/` — Growth agent

**Protocol for self-healing updates:**
1. Identify the broken behavior or missing instruction
2. When debugging broken queues or recurring bugs, prefer fixing agent docs/heartbeats so agents can resolve the queue themselves; do not manually mutate Paperclip issues/runs except when the user explicitly asks or when cancelling hung runs is the documented exception
3. SSH to openclaw and edit directly in `/home/mja311/src/shapekit-company/agents/`
4. Choose the right file: `HEARTBEAT.md` for process fixes, `SOUL.md` for behavioral fixes, `AGENTS.md` for capability/tool fixes
5. Commit and push: `git add -A && git commit -m "fix(agent): ..." && git push origin main`
6. No PR required for emergency fixes — but leave a clear commit message with the root cause

> Treat agent file changes like code changes: surgical and documented.

---

## Paperclip API Reference

Paperclip exposes a RESTful JSON API for all control plane operations.

**Docs**: `https://github.com/paperclipai/paperclip/tree/master/docs/api`
**Base URL**: `http://localhost:3100/api` (Local) / `https://192.168.5.28:32752/api` (Production)
**Auth**: `Authorization: Bearer <token>` (Agent run JWTs or API keys)

### Key Endpoints:
- `GET /api/companies/{companyId}/issues`
- `GET /api/companies/{companyId}/goals`
- `GET /api/companies/{companyId}/projects`
- `POST /api/companies/{companyId}/approvals`

_Note: All mutating requests during heartbeats must include the `X-Paperclip-Run-Id` header._

---

## Quick Reference

| Task | Command |
|------|---------|
| SSH to server | `ssh openclaw` (user: `mja311`) |
| View app logs | `sudo -u mja311 docker logs paperclip --tail 200` |
| Open postgres | `sudo -u mja311 docker exec paperclip-db psql -U paperclip -d paperclip` |
| Check containers | `sudo -u mja311 docker ps` |
| Agent files (live) | `ssh openclaw` → `/home/mja311/src/shapekit-company/agents/` |
| Performance/priority tuning | [performance.md](performance.md) |

---

## Fork Strategy: Running Multiple Open PRs Locally

> Established 2026-03-22. Openclaw runs Mike's fork `main`, not upstream `master`.

**Problem:** Multiple PRs open against `paperclipai/paperclip` that we want running in production on openclaw without waiting for upstream to merge them.

**Solution:** Merge all open PR branches into the fork's `main` branch. Openclaw checks out `mjaverto/main`. The individual PR branches stay untouched and open on upstream.

### Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `git@github.com:paperclipai/paperclip.git` | Upstream |
| `mjaverto` | `https://github.com/mjaverto/paperclip.git` | Fork |

Both remotes exist on the local Mac (`~/src/paperclip`) and on openclaw (`/home/mja311/src/paperclip`). On openclaw the fork remote is also aliased as `fork`.

### Adding a new PR to the fork

From `~/src/paperclip` on Mac:

```bash
git fetch origin && git fetch mjaverto
git checkout main
git reset --hard origin/master          # rebase fork main onto latest upstream
git merge --no-ff mjaverto/<branch-1> -m "Merge PR #NNN: description"
git merge --no-ff mjaverto/<branch-2> -m "Merge PR #NNN: description"
# ... repeat for each open PR branch
git push mjaverto main --force-with-lease
```

Then deploy to openclaw:

```bash
ssh openclaw "cd /home/mja311/src/paperclip && git fetch mjaverto && git checkout main && git pull mjaverto main && pnpm install && systemctl --user restart paperclip"
```

### When upstream merges one of our PRs

Rebuild fork main without that branch:

```bash
git fetch origin && git fetch mjaverto
git checkout main
git reset --hard origin/master          # now includes the merged PR
git merge --no-ff mjaverto/<remaining-branch-1> -m "Merge PR #NNN: description"
git merge --no-ff mjaverto/<remaining-branch-2> -m "Merge PR #NNN: description"
git push mjaverto main --force-with-lease
```

Then deploy to openclaw (same command as above).

### Syncing upstream changes (no PR was merged, just want latest master)

```bash
git fetch origin && git fetch mjaverto
git checkout main
git reset --hard origin/master
# re-merge all open PR branches
git merge --no-ff mjaverto/<branch-1> -m "Merge PR #NNN: description"
git merge --no-ff mjaverto/<branch-2> -m "Merge PR #NNN: description"
git push mjaverto main --force-with-lease
```

### Currently merged PRs (update this list)

| PR | Branch | Status |
|----|--------|--------|
| #277 | `feat/auto-requeue-on-failure` | Open on upstream, merged into fork main |
| #959 | `feature/heartbeat-pagination` | Open on upstream, merged into fork main |
| #1605 | `fix/opencode-adapter-tool-errors` | Open on upstream, merged into fork main |

### Conflict resolution

If merges conflict, resolve by keeping both sides — upstream base + PR additions. The PR branches themselves never get modified, so they stay clean for upstream review.

---

## Upgrading Paperclip

> **Note:** Openclaw now runs `mjaverto/main`, not `origin/master`. See "Fork Strategy" above. The legacy upgrade path below only applies if we switch back to running upstream directly.

```bash
# On openclaw:
cd /home/mja311/src/paperclip
git fetch origin
git checkout master
git pull origin master
pnpm install
systemctl --user restart paperclip
```

**Do not** use `pnpm run start`, `pnpm dev`, or `nohup node` manually — those spawn with pnpm's PATH (no Homebrew), which breaks `opencode models` discovery. Always use `systemctl --user restart paperclip`.

**After a restart**, verify models load:
```bash
curl -s 'http://localhost:3100/api/companies/<companyId>/adapters/opencode_local/models' \
  -H 'content-type: application/json' -b 'better-auth.session_token=<token>' | head -c 100
```
If it returns `[]`, the process PATH is wrong — kill any orphaned node processes and do a clean `systemctl --user restart paperclip`.

**Key env vars in the service file** (`~/.config/systemd/user/paperclip.service`):
- `PATH` — must include `/home/linuxbrew/.linuxbrew/bin` for opencode to resolve
- `PAPERCLIP_OPENCODE_COMMAND` — points to the priority wrapper (`/home/mja311/bin/opencode-prioritized`). See [performance.md](performance.md) for details on CPU priority scheduling.

After editing the service file: `systemctl --user daemon-reload && systemctl --user restart paperclip`

---

## Safety Rules

- **Never write to Postgres** during debugging
- **Never restart services** without confirming with Mike
- **Never merge agent file changes** without Founding Engineer review

---

## After Every Fix

**Always commit and push to `Shapekit/company` on openclaw after any agent file change:**

```bash
cd /home/mja311/src/shapekit-company
git add -A
git commit -m "fix(agent-name): brief description of what was fixed and why"
git push origin main
```

No exceptions — uncommitted fixes are lost on the next deploy or rebase.
