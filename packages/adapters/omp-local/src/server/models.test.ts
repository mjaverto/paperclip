import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOmpModels,
  ensureOmpModelConfiguredAndAvailable,
  listOmpModels,
  resetOmpModelsCacheForTests,
} from "./models.js";

function catalog(models: Array<Record<string, unknown>>): string {
  return JSON.stringify({ models });
}

describe("omp models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OMP_COMMAND;
    resetOmpModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OMP_COMMAND = "__paperclip_missing_omp_command__";
    await expect(listOmpModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOmpModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OMP requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OMP_COMMAND = "__paperclip_missing_omp_command__";
    await expect(
      ensureOmpModelConfiguredAndAvailable({
        model: "anthropic/claude-opus-4-6",
      }),
    ).rejects.toThrow();
  });

  it("parses the omp models --json catalog into provider/model selectors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-omp-models-"));
    const command = join(directory, "omp");
    await writeFile(
      command,
      `#!/bin/sh\ncat <<'EOF'\n${catalog([
        { provider: "anthropic", kind: "chat", id: "claude-opus-4-6", selector: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
        { provider: "openai", kind: "chat", id: "gpt-5.2", selector: "openai/gpt-5.2", name: "GPT-5.2" },
      ])}\nEOF\n`,
    );
    await chmod(command, 0o755);

    try {
      const models = await discoverOmpModels({ command });
      expect(models).toEqual([
        { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
        { id: "openai/gpt-5.2", label: "GPT-5.2" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("filters non-chat catalog kinds out of the selectable models", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-omp-models-"));
    const command = join(directory, "omp");
    await writeFile(
      command,
      `#!/bin/sh\ncat <<'EOF'\n${catalog([
        { provider: "anthropic", kind: "chat", id: "claude-opus-4-6", selector: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
        { provider: "omp", kind: "tiny", id: "session-titles", selector: "omp/session-titles", name: "Session Titles" },
      ])}\nEOF\n`,
    );
    await chmod(command, 0o755);

    try {
      const models = await discoverOmpModels({ command });
      expect(models).toEqual([{ id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not embed the model catalogue when the configured model is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-omp-models-"));
    const command = join(directory, "omp");
    const modelIds = Array.from({ length: 13 }, (_, index) => `provider/model-${index}`);
    await writeFile(
      command,
      `#!/bin/sh\ncat <<'EOF'\n${catalog(
        modelIds.map((id) => ({ provider: "provider", kind: "chat", id, selector: id, name: id })),
      )}\nEOF\n`,
    );
    await chmod(command, 0o755);

    try {
      await expect(
        ensureOmpModelConfiguredAndAvailable({
          command,
          model: "provider/missing",
        }),
      ).rejects.toMatchObject({
        message:
          "Configured OMP model is unavailable: provider/missing. 13 models are available; list them with `omp models --json`.",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
