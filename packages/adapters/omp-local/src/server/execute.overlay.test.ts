import { describe, expect, it } from "vitest";
import { buildOmpRunOverlay } from "./execute.js";

describe("buildOmpRunOverlay", () => {
  it("disables host skill sources, advisor, memory, and autolearn with bare keys", () => {
    expect(JSON.parse(buildOmpRunOverlay("/s", false))).toEqual({
      skills: {
        enableAgentsUser: false,
        enablePiUser: false,
        enableClaudeUser: false,
        enableCodexUser: false,
        customDirectories: ["/s"],
      },
      advisor: { enabled: false },
      memory: { backend: "off" },
      autolearn: { enabled: false },
    });
  });

  it("enables the advisor when a per-agent roster was staged", () => {
    expect(JSON.parse(buildOmpRunOverlay("/s", true))).toMatchObject({
      advisor: { enabled: true },
      memory: { backend: "off" },
    });
  });

  it("emits parseable YAML ending in a newline", () => {
    const overlay = buildOmpRunOverlay("/staged/skills", false);
    expect(overlay.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(overlay)).not.toThrow();
  });
});
