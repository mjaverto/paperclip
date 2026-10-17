import { describe, expect, it } from "vitest";
import { parseOmpJsonl, isOmpUnknownSessionError } from "./parse.js";

describe("parseOmpJsonl", () => {
  it("parses agent lifecycle and messages", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from OMP" }],
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.messages).toContain("Hello from OMP");
    expect(parsed.finalMessage).toBe("Hello from OMP");
  });

  it("parses streaming text deltas", () => {
    const stdout = [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "World" },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Hello World",
        },
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.messages).toContain("Hello World");
  });

  it("parses tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/tmp/test.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "file contents",
        isError: false,
      }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "Done" },
        toolResults: [
          {
            toolCallId: "tool_1",
            content: "file contents",
            isError: false,
          },
        ],
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].toolName).toBe("read");
    expect(parsed.toolCalls[0].result).toBe("file contents");
    expect(parsed.toolCalls[0].isError).toBe(false);
  });

  it("handles errors in tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/missing.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "File not found",
        isError: true,
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].isError).toBe(true);
    expect(parsed.toolCalls[0].result).toBe("File not found");
  });

  it("extracts usage and cost from turn_end events", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Response with usage",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            totalTokens: 170,
            cost: {
              input: 0.001,
              output: 0.0015,
              cacheRead: 0.0001,
              cacheWrite: 0,
              total: 0.0026,
            },
          },
        },
        toolResults: [],
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(50);
    expect(parsed.usage.cachedInputTokens).toBe(20);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0026, 4);
  });

  it("accumulates usage from multiple turns", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "First response",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cost: { total: 0.001 },
          },
        },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Second response",
          usage: {
            input: 30,
            output: 20,
            cacheRead: 10,
            cost: { total: 0.0015 },
          },
        },
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(45);
    expect(parsed.usage.cachedInputTokens).toBe(10);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0025, 4);
  });

  it("handles standalone usage events with Pi-compatible format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          input: 200,
          output: 100,
          cacheRead: 50,
          cost: { total: 0.005 },
        },
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(200);
    expect(parsed.usage.outputTokens).toBe(100);
    expect(parsed.usage.cachedInputTokens).toBe(50);
    expect(parsed.usage.costUsd).toBe(0.005);
  });

  it("handles standalone usage events with generic format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          inputTokens: 150,
          outputTokens: 75,
          cachedInputTokens: 25,
          costUsd: 0.003,
        },
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(150);
    expect(parsed.usage.outputTokens).toBe(75);
    expect(parsed.usage.cachedInputTokens).toBe(25);
    expect(parsed.usage.costUsd).toBe(0.003);
  });

  it("surfaces failed auto-retry exhaustion as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED",
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.errors).toEqual(["Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"]);
  });

  it("does not treat successful auto-retry as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });

  it("surfaces standalone error events", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "Connection to model provider lost",
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.errors).toEqual(["Connection to model provider lost"]);
  });

  it("ignores error events with empty messages", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "",
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });
});

describe("isOmpUnknownSessionError", () => {
  it("detects unknown session errors", () => {
    expect(isOmpUnknownSessionError("session not found: s_123", "")).toBe(true);
    expect(isOmpUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOmpUnknownSessionError("", "no session available")).toBe(true);
    expect(isOmpUnknownSessionError("all good", "")).toBe(false);
    expect(isOmpUnknownSessionError("working fine", "no errors")).toBe(false);
  });
});


describe("terminal provider failures", () => {
  it("surfaces and deduplicates errors from OMP assistant messages", () => {
    const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "400 Context limit exceeded" };
    const parsed = parseOmpJsonl([
      { type: "message_end", message },
      { type: "turn_end", message },
      { type: "agent_end", messages: [message] },
    ].map(event => JSON.stringify(event)).join("\n"));
    expect(parsed.errors).toEqual(["400 Context limit exceeded"]);
  });
  it("reports an error even when the provider omitted its message", () => {
    expect(parseOmpJsonl(JSON.stringify({ type: "turn_end", message: { role: "assistant", stopReason: "error" } })).errors)
      .toEqual(["OMP provider request failed."]);
  });
});

describe("OMP session and advisor events", () => {
  it("captures the session id announced by the session event", () => {
    const stdout = [
      JSON.stringify({ type: "session", version: 3, id: "01a14ad8-830d", timestamp: "2026-10-17T17:11:05.741Z", cwd: "/tmp/omp-probe/ws" }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({ type: "agent_end", isTerminal: true, yielded: true }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.sessionId).toBe("01a14ad8-830d");
    expect(parsed.finalMessage).toBe("hello");
    expect(parsed.sawAgentEnd).toBe(true);
  });

  it("ignores advisor telemetry events", () => {
    const stdout = [
      JSON.stringify({ type: "advisor_cost_changed", cost: 0.01 }),
      JSON.stringify({ type: "advisor_yielded", note: "consider x" }),
      JSON.stringify({ type: "session", id: "abc-1" }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.sessionId).toBe("abc-1");
    expect(parsed.messages).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });
});

describe("OMP price availability", () => {
  it("retains unpriced usage and counts cache writes without treating a missing price as free", () => {
    const event = { type: "turn_end", message: { role: "assistant", content: [], usage: { input: 10, output: 3, cacheRead: 100, cacheWrite: 20 } } };
    expect(parseOmpJsonl(JSON.stringify(event)).usage).toEqual({ inputTokens: 30, cachedInputTokens: 100, outputTokens: 3, costUsd: null });
    event.message.usage = { ...event.message.usage, cost: { total: 0 } } as typeof event.message.usage;
    expect(parseOmpJsonl(JSON.stringify(event)).usage.costUsd).toBe(0);
  });
});
