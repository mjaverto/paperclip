import type { DashboardRunActivityDay } from "@paperclipai/shared";
import type { HeartbeatRunStats } from "../api/heartbeats";

/**
 * Fold the grouped (day, status) buckets from `GET /heartbeat-runs/stats`
 * into the per-day shape `RunActivityChart` renders. The stats endpoint carries
 * no retry-chain or error-code data, so `recovered` and `failedByErrorCode`
 * stay empty.
 */
export function runStatsToActivity(stats: readonly HeartbeatRunStats[]): DashboardRunActivityDay[] {
  const byDate = new Map<string, DashboardRunActivityDay>();
  for (const bucket of stats) {
    let day = byDate.get(bucket.date);
    if (!day) {
      day = { date: bucket.date, succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {} };
      byDate.set(bucket.date, day);
    }
    if (bucket.status === "succeeded") day.succeeded += bucket.count;
    else if (bucket.status === "failed" || bucket.status === "timed_out") day.failed += bucket.count;
    else day.other += bucket.count;
    day.total += bucket.count;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
