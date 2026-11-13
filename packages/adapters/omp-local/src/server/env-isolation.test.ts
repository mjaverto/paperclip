import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverOmpModels, resetOmpModelsCacheForTests } from "./models.js";
import { testEnvironment } from "./test.js";

// Only these keys are written out by the stub, so the test never copies the developer's real
// environment into a temp file.
const WATCHED_KEYS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_PSQL_PATH",
  "UNRELATED_AMBIENT",
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
] as const;

function fakeOmpScript(dumpDir: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const watched = ${JSON.stringify(WATCHED_KEYS)};
const kind = process.argv[2] === "models" ? "models" : "probe";
fs.writeFileSync(path.join(${JSON.stringify(dumpDir)}, kind + ".json"), JSON.stringify(Object.fromEntries(watched.map((key) => [key, process.env[key] ?? null]))));
if (kind === "models") {
  console.log(JSON.stringify({ models: [{ provider: "anthropic", id: "claude-stub", selector: "anthropic/claude-stub", kind: "chat", name: "Stub" }] }));
} else {
  console.log(JSON.stringify({ type: "agent_end", messages: [] }));
}
`;
}

const EXPECTED = {
  PAPERCLIP_AGENT_JWT_SECRET: null,
  PAPERCLIP_PSQL_PATH: null,
  UNRELATED_AMBIENT: "inherited",
  DATABASE_URL: "explicit-database-url",
  // Ambient on the server but not configured by the agent, so it must be dropped.
  DATABASE_MIGRATION_URL: null,
};

describe("omp_local discovery and environment-test process environment", () => {
  let root: string;
  let command: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-enviso-"));
    command = path.join(root, "omp");
    await fs.writeFile(command, fakeOmpScript(root), { mode: 0o755 });
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "server-signing-secret");
    vi.stubEnv("PAPERCLIP_PSQL_PATH", "/server/only/psql");
    vi.stubEnv("UNRELATED_AMBIENT", "inherited");
    vi.stubEnv("DATABASE_URL", "ambient-database-url");
    vi.stubEnv("DATABASE_MIGRATION_URL", "ambient-migration-url");
    resetOmpModelsCacheForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetOmpModelsCacheForTests();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("omp models --json discovery does not inherit server Paperclip secrets", async () => {
    const models = await discoverOmpModels({
      command,
      cwd: root,
      env: { DATABASE_URL: "explicit-database-url" },
    });
    expect(models.map((m) => m.id)).toContain("anthropic/claude-stub");
    expect(JSON.parse(await fs.readFile(path.join(root, "models.json"), "utf8"))).toEqual(EXPECTED);
  }, 30_000);

  it("environment test (discovery + hello probe) does not inherit server Paperclip secrets", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "omp_local",
      config: {
        command,
        cwd: root,
        model: "anthropic/claude-stub",
        env: { DATABASE_URL: "explicit-database-url" },
      },
    });
    expect(result.checks.map((c) => c.code)).toContain("omp_models_discovered");
    expect(JSON.parse(await fs.readFile(path.join(root, "models.json"), "utf8"))).toEqual(EXPECTED);
    expect(JSON.parse(await fs.readFile(path.join(root, "probe.json"), "utf8"))).toEqual(EXPECTED);
  }, 60_000);

  it("drops the ambient database URLs from discovery and the probe when the agent configures none", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "omp_local",
      config: { command, cwd: root, model: "anthropic/claude-stub" },
    });
    expect(result.checks.map((c) => c.code)).toContain("omp_models_discovered");
    for (const file of ["models.json", "probe.json"]) {
      expect(JSON.parse(await fs.readFile(path.join(root, file), "utf8"))).toMatchObject({
        DATABASE_URL: null,
        DATABASE_MIGRATION_URL: null,
        UNRELATED_AMBIENT: "inherited",
      });
    }
  }, 60_000);
});
