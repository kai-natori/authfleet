import type { DailySignup, SnapshotRecord, UserStats } from "./types";

export function dateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Sum signups whose date falls in the last `days` days, today included. */
export function sumSignupWindow(daily: DailySignup[], days: number, now = new Date()): number {
  const cutoff = dateString(new Date(now.getTime() - (days - 1) * 86_400_000));
  return daily.filter((d) => d.date >= cutoff).reduce((sum, d) => sum + d.count, 0);
}

export interface SnapshotGrowth {
  firstDate: string;
  latestDate: string;
  firstTotal: number;
  latestTotal: number;
  delta: number;
  deltaPercent: number | null;
  spanDays: number;
}

/** Growth between the oldest and newest snapshot; null with < 2 points. */
export function growthFromSnapshots(snapshots: SnapshotRecord[]): SnapshotGrowth | null {
  if (snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  if (!first || !latest || first.date === latest.date) return null;
  const delta = latest.totalUsers - first.totalUsers;
  const spanDays = Math.round((Date.parse(latest.date) - Date.parse(first.date)) / 86_400_000);
  return {
    firstDate: first.date,
    latestDate: latest.date,
    firstTotal: first.totalUsers,
    latestTotal: latest.totalUsers,
    delta,
    deltaPercent: first.totalUsers > 0 ? (delta / first.totalUsers) * 100 : null,
    spanDays,
  };
}

export interface ProjectStatsSummary {
  stats: UserStats;
  newLast7Days: number;
  newLast30Days: number;
  snapshots: SnapshotRecord[];
  growth: SnapshotGrowth | null;
}

export function buildStatsSummary(
  stats: UserStats,
  snapshots: SnapshotRecord[],
  now = new Date(),
): ProjectStatsSummary {
  return {
    stats,
    newLast7Days: sumSignupWindow(stats.dailySignups, 7, now),
    newLast30Days: sumSignupWindow(stats.dailySignups, 30, now),
    snapshots,
    growth: growthFromSnapshots(snapshots),
  };
}
