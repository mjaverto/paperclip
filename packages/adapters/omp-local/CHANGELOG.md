# @paperclipai/adapter-omp-local

## Unreleased

### Patch Changes

- Allow advisor rosters on native models. A roster is now staged when the run has
  OMP_AUTH_BROKER_URL (existing OMP subscription logins through `omp auth-broker
  serve`, never copied into per-run or remote assets) or PAPERCLIP_OMP_PROVIDERS;
  with neither it stays unstaged with a config-gap note, because the managed agent
  dir hides host logins. Document Sonnet with Opus and Codex-backed GPT advisors
  and the difference between the Codex login (`openai-codex/...`) and OpenAI
  API-key (`openai/...`) selectors.
- Stop handing the server's own Paperclip-internal environment to agent processes.
  `omp_local` merged the raw server `process.env` into the env it passed to the
  runner, which defeated the runner's inherited-env filter, so any agent that ran
  `env` could read `PAPERCLIP_AGENT_JWT_SECRET` (which signs every agent's token)
  plus the server's psql/pg_dump paths. The merge now starts from
  `sanitizeInheritedPaperclipEnv(process.env)`; per-run Paperclip variables and the
  agent's own configured env are unchanged and still win.

## 0.1.0

### Minor Changes

- Initial release: `omp_local` adapter runs the OMP (Oh My Pi) coding agent
  (`omp` CLI, npm `@oh-my-pi/pi-coding-agent`) locally with dynamic model
  discovery via `omp models --json`, session resume across heartbeats via
  `--resume` with a managed `--session-dir`, per-run skills staging through a
  `--config` overlay, custom provider materialization into a managed
  `models.yml`, and OMP-specific config fields (`smolModel`, `slowModel`,
  `planModel`, `tools`, `maxTimeSec`, `noLsp`, `noPty`).
