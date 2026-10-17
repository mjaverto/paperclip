# @paperclipai/adapter-omp-local

## 0.1.0

### Minor Changes

- Initial release: `omp_local` adapter runs the OMP (Oh My Pi) coding agent
  (`omp` CLI, npm `@oh-my-pi/pi-coding-agent`) locally with dynamic model
  discovery via `omp models --json`, session resume across heartbeats via
  `--resume` with a managed `--session-dir`, per-run skills staging through a
  `--config` overlay, custom provider materialization into a managed
  `models.yml`, and OMP-specific config fields (`smolModel`, `slowModel`,
  `planModel`, `tools`, `maxTimeSec`, `noLsp`, `noPty`).
