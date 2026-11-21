import type { ProjectStatsSummary, SnapshotGrowth } from "@authfleet/core";

export function snapshotChartData(summary: ProjectStatsSummary | undefined) {
  return summary
    ? [...summary.snapshots]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((snap) => ({ date: snap.date, total: snap.totalUsers }))
    : [];
}

export function signupChartData(summary: ProjectStatsSummary | undefined) {
  return summary
    ? [...summary.stats.dailySignups]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((day) => ({ date: day.date, count: day.count }))
    : [];
}

export function growthDescription(growth: SnapshotGrowth | null): string {
  return growth
    ? `${growth.firstTotal.toLocaleString()} users on ${growth.firstDate} → ${growth.latestTotal.toLocaleString()} on ${growth.latestDate} (${growth.delta >= 0 ? "+" : ""}${growth.delta.toLocaleString()}${growth.deltaPercent !== null ? `, ${growth.deltaPercent.toFixed(1)}%` : ""} over ${growth.spanDays} days, from daily snapshots)`
    : "Not enough snapshots yet — the api Worker records one per day, and growth appears once two exist.";
}
