import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("drops the server's ambient database credentials in any key case and keeps unrelated env", () => {
    expect(sanitizeInheritedPaperclipEnv({
      DATABASE_URL: "postgres://paperclip:secret@db/paperclip",
      DATABASE_MIGRATION_URL: "postgres://migrator:secret@db/paperclip",
      database_url: "postgres://paperclip:secret@db/paperclip",
      Database_Migration_Url: "postgres://migrator:secret@db/paperclip",
      DATABASE_POOL_MAX: "10",
      PATH: "/usr/bin",
      UNRELATED_AMBIENT: "inherited",
    })).toEqual({
      DATABASE_POOL_MAX: "10",
      PATH: "/usr/bin",
      UNRELATED_AMBIENT: "inherited",
    });
  });

  it("does not mutate the env it sanitizes", () => {
    const base = { DATABASE_URL: "postgres://paperclip:secret@db/paperclip", PATH: "/usr/bin" };
    sanitizeInheritedPaperclipEnv(base);
    expect(base.DATABASE_URL).toBe("postgres://paperclip:secret@db/paperclip");
  });

  it("lets an explicit env layered on top of the sanitized base set DATABASE_URL", () => {
    const merged = {
      ...sanitizeInheritedPaperclipEnv({ DATABASE_URL: "ambient", PATH: "/usr/bin" }),
      DATABASE_URL: "configured",
    };
    expect(merged).toEqual({ DATABASE_URL: "configured", PATH: "/usr/bin" });
  });
});

describe("runChildProcess database credential inheritance", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function dumpChildDatabaseEnv(env: Record<string, string>) {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify([process.env.DATABASE_URL ?? null, process.env.DATABASE_MIGRATION_URL ?? null, process.env.UNRELATED_AMBIENT ?? null]))"],
      { cwd: process.cwd(), env, timeoutSec: 10, graceSec: 1, onLog: async () => {} },
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as [string | null, string | null, string | null];
  }

  it("does not hand the server's ambient database URLs to a child", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://paperclip:ambient-secret@db/paperclip");
    vi.stubEnv("DATABASE_MIGRATION_URL", "postgres://migrator:ambient-secret@db/paperclip");
    vi.stubEnv("UNRELATED_AMBIENT", "inherited");
    expect(await dumpChildDatabaseEnv({})).toEqual([null, null, "inherited"]);
  });

  it("still passes a database URL the caller configures explicitly", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://paperclip:ambient-secret@db/paperclip");
    vi.stubEnv("DATABASE_MIGRATION_URL", "postgres://migrator:ambient-secret@db/paperclip");
    expect(await dumpChildDatabaseEnv({ DATABASE_URL: "configured-url" })).toEqual(["configured-url", null, null]);
  });
});
