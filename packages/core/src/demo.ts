import { dateString } from "./stats";
import type { DailySignup, ProjectRecord, SnapshotRecord, UserStats } from "./types";

/**
 * Demo mode: a fixture project with deterministic fake data, so the
 * dashboard can be seen end-to-end without real credentials.
 * The demo project is virtual (never stored in the registry D1).
 */

export const DEMO_PROJECT_ID = "demo";

export function demoProject(): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: DEMO_PROJECT_ID,
    name: "Demo — Acme",
    cfAccountId: "demo-account",
    d1DatabaseId: "demo-database",
    tokenCiphertext: "",
    tokenIv: "",
    tokenHint: "demo",
    isDemo: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** Deterministic pseudo-random in [0, 1) from a string seed. */
function seeded(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

const DEMO_BASE_TOTAL = 1180;
export const DEMO_DAYS = 60;

function demoDailySignups(now: Date): DailySignup[] {
  const days: DailySignup[] = [];
  for (let i = DEMO_DAYS - 1; i >= 0; i--) {
    const date = dateString(new Date(now.getTime() - i * 86_400_000));
    const base = 14 + Math.round(seeded(`growth:${date}`) * 18) + (DEMO_DAYS - i) * 0.12;
    days.push({ date, count: Math.max(0, Math.round(base)) });
  }
  return days;
}

export function demoStats(now = new Date()): UserStats {
  const dailySignups = demoDailySignups(now);
  const gained = dailySignups.reduce((s, d) => s + d.count, 0);
  return {
    totalUsers: DEMO_BASE_TOTAL + gained,
    anonymousUsers: 312,
    dailySignups,
    asOf: now.toISOString(),
  };
}

export function demoSnapshots(now = new Date()): SnapshotRecord[] {
  const daily = demoDailySignups(now);
  const snapshots: SnapshotRecord[] = [];
  let total = DEMO_BASE_TOTAL;
  for (const day of daily) {
    total += day.count;
    snapshots.push({
      id: `demo-snap-${day.date}`,
      projectId: DEMO_PROJECT_ID,
      date: day.date,
      totalUsers: total,
      createdAt: now.toISOString(),
    });
  }
  return snapshots;
}
