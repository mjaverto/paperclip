import { describe, expect, it } from "vitest";
import { runStatsToActivity } from "./run-stats";

describe("runStatsToActivity", () => {
  it("folds status buckets into sorted per-day totals", () => {
    const activity = runStatsToActivity([
      { date: "2026-03-02", status: "failed", count: 2 },
      { date: "2026-03-01", status: "succeeded", count: 3 },
      { date: "2026-03-02", status: "timed_out", count: 1 },
      { date: "2026-03-02", status: "cancelled", count: 4 },
      { date: "2026-03-02", status: "succeeded", count: 5 },
    ]);
    expect(activity).toEqual([
      { date: "2026-03-01", succeeded: 3, failed: 0, recovered: 0, other: 0, total: 3, failedByErrorCode: {} },
      { date: "2026-03-02", succeeded: 5, failed: 3, recovered: 0, other: 4, total: 12, failedByErrorCode: {} },
    ]);
  });

  it("returns an empty list for no buckets", () => {
    expect(runStatsToActivity([])).toEqual([]);
  });
});
