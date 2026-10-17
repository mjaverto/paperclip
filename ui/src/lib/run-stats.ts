import type { DashboardRunActivityDay } from "@paperclipai/shared";
import type { HeartbeatRunStats } from "../api/heartbeats";

const RUN_ACTIVITY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The trailing `days` UTC date keys ending today, oldest first (same window as the company dashboard). */
function recentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) =>
    new Date(todayUtc + (index - (days - 1)) * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * Fold the grouped (day, status) buckets from `GET /heartbeat-runs/stats` into
 * the per-day shape `RunActivityChart` renders, padded to the trailing 14 UTC
 * days so empty days keep their slot. The stats endpoint carries no retry-chain
 * or error-code data, so `recovered` and `failedByErrorCode` stay empty.
 */
export function runStatsToActivity(stats: readonly HeartbeatRunStats[], now: Date = new Date()): DashboardRunActivityDay[] {
  const byDate: Record<string, DashboardRunActivityDay> = {};
  for (const date of recentUtcDateKeys(now, RUN_ACTIVITY_DAYS)) {
    byDate[date] = { date, succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {} };
  }
  for (const bucket of stats) {
    const day = byDate[bucket.date];
    if (!day) continue;
    if (bucket.status === "succeeded") day.succeeded += bucket.count;
    else if (bucket.status === "failed" || bucket.status === "timed_out") day.failed += bucket.count;
    else day.other += bucket.count;
    day.total += bucket.count;
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}
