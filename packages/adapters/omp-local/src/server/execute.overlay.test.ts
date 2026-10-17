import { describe, expect, it } from "vitest";
import { buildOmpRunOverlay } from "./execute.js";

describe("buildOmpRunOverlay", () => {
  it("disables host skill sources, advisor, memory, and autolearn with bare keys", () => {
    expect(JSON.parse(buildOmpRunOverlay("/s"))).toEqual({
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

  it("emits parseable YAML ending in a newline", () => {
    const overlay = buildOmpRunOverlay("/staged/skills");
    expect(overlay.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(overlay)).not.toThrow();
  });
});
