import { describe, expect, it } from "vitest";
import { runStatsToActivity } from "./run-stats";

const NOW = new Date("2026-03-14T09:30:00.000Z");
const empty = (date: string) => ({ date, succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {} });

describe("runStatsToActivity", () => {
  it("pads to the trailing 14 UTC days, oldest first, with empty days kept", () => {
    const activity = runStatsToActivity([], NOW);
    expect(activity).toHaveLength(14);
    expect(activity[0]).toEqual(empty("2026-03-01"));
    expect(activity[13]).toEqual(empty("2026-03-14"));
  });

  it("folds status buckets into per-day totals", () => {
    const activity = runStatsToActivity(
      [
        { date: "2026-03-13", status: "failed", count: 2 },
        { date: "2026-03-12", status: "succeeded", count: 3 },
        { date: "2026-03-13", status: "timed_out", count: 1 },
        { date: "2026-03-13", status: "cancelled", count: 4 },
        { date: "2026-03-13", status: "succeeded", count: 5 },
      ],
      NOW,
    );
    expect(activity.find((day) => day.date === "2026-03-12")).toEqual({ ...empty("2026-03-12"), succeeded: 3, total: 3 });
    expect(activity.find((day) => day.date === "2026-03-13")).toEqual({
      ...empty("2026-03-13"), succeeded: 5, failed: 3, other: 4, total: 12,
    });
  });

  it("ignores buckets outside the window", () => {
    const activity = runStatsToActivity([{ date: "2026-02-01", status: "succeeded", count: 9 }], NOW);
    expect(activity.every((day) => day.total === 0)).toBe(true);
  });
});
