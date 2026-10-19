import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

// execute.ts captures os.homedir() as its session root when the module loads, so HOME has to
// point at scratch space before the static import above is evaluated. vi.hoisted runs first.
const scratch = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? "/tmp"}/paperclip-omp-env-${process.pid}`;
  vi.stubEnv("HOME", `${root}/home`);
  return { root };
});

// Only these keys are written out by the stub, so the test never copies the developer's real
// environment (tokens included) into a temp file.
const WATCHED_KEYS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_PSQL_PATH",
  "PAPERCLIP_AGENT_ID",
  "UNRELATED_AMBIENT",
  "DATABASE_URL",
] as const;

function fakeOmpScript(dumpPath: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "models") {
  console.log(JSON.stringify({ models: [{ provider: "anthropic", id: "claude-stub", selector: "anthropic/claude-stub", kind: "chat", name: "Stub" }] }));
  process.exit(0);
}
const watched = ${JSON.stringify(WATCHED_KEYS)};
fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(Object.fromEntries(watched.map((key) => [key, process.env[key] ?? null]))));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
`;
}

describe("omp_local agent process environment", () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fs.rm(scratch.root, { recursive: true, force: true });
  });

  it("keeps the server's own Paperclip secrets away from the agent while configured env still wins", async () => {
    const cwd = path.join(scratch.root, "work");
    const command = path.join(scratch.root, "omp");
    const dumpPath = path.join(scratch.root, "child-env.json");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(command, fakeOmpScript(dumpPath), { mode: 0o755 });

    // The server process holds these; an agent that dumps its environment must not see them.
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "server-signing-secret");
    vi.stubEnv("PAPERCLIP_PSQL_PATH", "/server/only/psql");
    vi.stubEnv("UNRELATED_AMBIENT", "inherited");
    vi.stubEnv("DATABASE_URL", "ambient-database-url");

    const result = await execute({
      runId: "run-env-1",
      agent: { id: "agent-env-1", companyId: "company-env-1", name: "Env test", adapterType: "omp_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command,
        cwd,
        model: "anthropic/claude-stub",
        promptTemplate: "go",
        env: { DATABASE_URL: "explicit-database-url" },
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await fs.readFile(dumpPath, "utf8"))).toEqual({
      // Server-only Paperclip values never reach the agent.
      PAPERCLIP_AGENT_JWT_SECRET: null,
      PAPERCLIP_PSQL_PATH: null,
      // Per-run identity is set explicitly and survives; ordinary ambient env still flows through.
      PAPERCLIP_AGENT_ID: "agent-env-1",
      UNRELATED_AMBIENT: "inherited",
      // An agent's own configured env overrides the server's ambient value.
      DATABASE_URL: "explicit-database-url",
    });
  }, 30_000);
});
