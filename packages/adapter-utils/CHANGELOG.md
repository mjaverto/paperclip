# @paperclipai/adapter-utils

## Unreleased

### Patch Changes

- Allow the Paperclip host to route adapter sandbox-sync full-tree Git enumeration through its process-wide bounded scheduler.
- Stop handing the server's database credentials to agent child processes.
  `sanitizeInheritedPaperclipEnv` now also drops `DATABASE_URL` and
  `DATABASE_MIGRATION_URL` (any key case) from the inherited server env, so an
  agent that runs `env` no longer sees the Postgres password. An adapter's own
  configured env is merged after the sanitized base and still wins. Workspace
  provision, runtime-provision and seed command env on the server also drops
  both keys while keeping every other variable, including `PAPERCLIP_*`.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)

## 0.2.6

### Patch Changes

- Version bump (patch)

## 0.2.5

### Patch Changes

- Version bump (patch)

## 0.2.4

### Patch Changes

- Version bump (patch)

## 0.2.3

### Patch Changes

- Version bump (patch)

## 0.2.2

### Patch Changes

- Version bump (patch)

## 0.2.1

### Patch Changes

- Version bump (patch)
