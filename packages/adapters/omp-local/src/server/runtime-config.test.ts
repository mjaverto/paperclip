import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOmpRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function readModelsYml(agentConfigDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentConfigDir, "models.yml"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("prepareOmpRuntimeConfig", () => {
  it("is a no-op when PAPERCLIP_OMP_PROVIDERS is unset", async () => {
    const prepared = await prepareOmpRuntimeConfig({ env: { FOO: "bar" } });

    expect(prepared.env).toEqual({ FOO: "bar" });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    expect(prepared.advisorEnabled).toBe(false);
    await prepared.cleanup();
  });

  it("stages a roster when only the OMP auth broker is configured", async () => {
    const roster = "advisors:\n- name: Gate\n  model: anthropic/claude-opus-5-5\n";
    const env = { OMP_AUTH_BROKER_URL: "http://127.0.0.1:8765" };
    const prepared = await prepareOmpRuntimeConfig({ env, advisorRoster: roster });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);

    expect(prepared.advisorEnabled).toBe(true);
    expect(prepared.env.OMP_AUTH_BROKER_URL).toBe(env.OMP_AUTH_BROKER_URL);
    await expect(fs.readFile(path.join(agentConfigDir, "WATCHDOG.yml"), "utf8")).resolves.toBe(roster);
    // Native model auth stays in the broker, not in the portable run assets.
    expect(await fs.readdir(agentConfigDir)).toEqual(["WATCHDOG.yml"]);
    await prepared.cleanup();
    await expect(fs.access(agentConfigDir)).rejects.toThrow();
  });

  it("does not stage a roster without a broker or providers and surfaces the config gap", async () => {
    const previousBroker = process.env.OMP_AUTH_BROKER_URL;
    delete process.env.OMP_AUTH_BROKER_URL;
    try {
      const roster = "advisors:\n- name: Gate\n  model: example/gate-model\n";
      const prepared = await prepareOmpRuntimeConfig({ env: {}, advisorRoster: roster });

      // The staged dir replaces the host agent dir wholesale and hides host OMP
      // logins; without a broker or providers it would break the primary model.
      expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
      expect(prepared.agentConfigDir).toBeNull();
      expect(prepared.advisorEnabled).toBe(false);
      expect(prepared.notes).toHaveLength(1);
      expect(prepared.notes[0]).toContain("neither OMP_AUTH_BROKER_URL nor PAPERCLIP_OMP_PROVIDERS is set");
      await prepared.cleanup();
    } finally {
      if (previousBroker !== undefined) process.env.OMP_AUTH_BROKER_URL = previousBroker;
    }
  });

  it("warns that advisor models need credentials when staging with providers but no broker", async () => {
    const previousBroker = process.env.OMP_AUTH_BROKER_URL;
    delete process.env.OMP_AUTH_BROKER_URL;
    try {
      const providers = { tensorix: { baseUrl: "http://gw/anthropic", apiKey: "k", api: "anthropic-messages", models: [] } };
      const prepared = await prepareOmpRuntimeConfig({
        env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
        advisorRoster: "advisors: []\n",
      });
      cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);

      expect(prepared.advisorEnabled).toBe(true);
      expect(prepared.notes.some((n) => n.includes("OMP_AUTH_BROKER_URL is not set"))).toBe(true);
      await prepared.cleanup();
    } finally {
      if (previousBroker !== undefined) process.env.OMP_AUTH_BROKER_URL = previousBroker;
    }
  });

  it("stages both the roster and models.yml when providers and a roster are set", async () => {
    const providers = {
      tensorix: {
        baseUrl: "http://gw/anthropic",
        apiKey: "k",
        api: "anthropic-messages",
        models: [],
      },
    };
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
      advisorRoster: "advisors: []\n",
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);

    expect(prepared.advisorEnabled).toBe(true);
    expect((await readModelsYml(agentConfigDir)).providers).toEqual(providers);
    await expect(
      fs.readFile(path.join(agentConfigDir, "WATCHDOG.yml"), "utf8"),
    ).resolves.toBe("advisors: []\n");
    await prepared.cleanup();
  });

  it("treats a whitespace-only roster as unset and stages nothing", async () => {
    const prepared = await prepareOmpRuntimeConfig({ env: {}, advisorRoster: "   \n" });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.advisorEnabled).toBe(false);
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("writes the providers JSON verbatim to a managed models.yml and points PI_CODING_AGENT_DIR at it", async () => {
    const providers = {
      tensorix: {
        baseUrl: "http://gateway.example.svc.cluster.local:8080/anthropic",
        apiKey: "sk-literal",
        api: "anthropic-messages",
        models: [
          {
            id: "deepseek/deepseek-chat-v3.1",
            name: "DeepSeek v3.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    };

    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    cleanupPaths.add(agentConfigDir);

    expect(await readModelsYml(agentConfigDir)).toEqual({ providers });
    expect(prepared.notes.some((n) => n.includes("tensorix"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(agentConfigDir);
    await expect(fs.access(agentConfigDir)).rejects.toThrow();
  });

  it("reads PAPERCLIP_OMP_PROVIDERS from process.env when absent from the run env", async () => {
    const providers = { tensorix: { baseUrl: "http://gw/anthropic", api: "anthropic-messages", models: [] } };
    process.env.PAPERCLIP_OMP_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await prepareOmpRuntimeConfig({ env: {} });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      expect(agentConfigDir).toBeTruthy();
      cleanupPaths.add(agentConfigDir);
      expect(await readModelsYml(agentConfigDir)).toEqual({ providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_OMP_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders from the run env (bakes the literal key)", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:ANTHROPIC_API_KEY}", api: "anthropic-messages", models: [] },
    };
    const prepared = await prepareOmpRuntimeConfig({
      env: {
        PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers),
        ANTHROPIC_API_KEY: "sk-bf-REALVK",
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsYml = (await readModelsYml(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsYml.providers.tensorix.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("expands {env:VAR} placeholders from process.env when absent from the run env", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:PAPERCLIP_OMP_TEST_KEY}", api: "anthropic-messages", models: [] },
    };
    process.env.PAPERCLIP_OMP_TEST_KEY = "sk-from-process-env";
    try {
      const prepared = await prepareOmpRuntimeConfig({
        env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
      });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const modelsYml = (await readModelsYml(agentConfigDir)) as {
        providers: { tensorix: { apiKey: string } };
      };
      expect(modelsYml.providers.tensorix.apiKey).toBe("sk-from-process-env");
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_OMP_TEST_KEY;
    }
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}", api: "anthropic-messages", models: [] },
    };
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsYml = (await readModelsYml(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsYml.providers.tensorix.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_OMP_PROVIDERS without writing a config", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: "not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("ignores provider entries that are not objects and names them in the note", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify({ tensorix: "nope" }) },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS: skipped provider(s) with non-object values: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces skipped non-object entries while keeping the usable ones", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: {
        PAPERCLIP_OMP_PROVIDERS: JSON.stringify({
          bad: "http://gw/v1",
          tensorix: { baseUrl: "http://gw/anthropic", apiKey: "k", api: "anthropic-messages", models: [] },
        }),
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    expect(prepared.agentConfigDir).toBe(agentConfigDir);
    const modelsYml = (await readModelsYml(agentConfigDir)) as {
      providers: Record<string, unknown>;
    };
    expect(modelsYml.providers.tensorix).toBeDefined();
    expect(modelsYml.providers.bad).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS: skipped provider(s) with non-object values: bad.",
      "Injected 1 custom OMP provider(s) from PAPERCLIP_OMP_PROVIDERS into a managed models.yml: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OMP_PROVIDERS contains invalid JSON", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: "{not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OMP_PROVIDERS is not a JSON object", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: "[1,2]" },
    });
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces the skipped entries when no provider objects remain", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: '{"a": 1}' },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS: skipped provider(s) with non-object values: a.",
    ]);
    await prepared.cleanup();
  });

  it("stays silent when PAPERCLIP_OMP_PROVIDERS is an empty object", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: "{}" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });
});
