import { buildStatsSummary, demoSnapshots, demoStats } from "@authfleet/core";
import { describe, expect, it } from "vitest";
import { growthDescription, signupChartData, snapshotChartData } from "../src/lib/dashboard-data";

describe("dashboard chart data", () => {
  it("handles unavailable and empty summaries", () => {
    expect(snapshotChartData(undefined)).toEqual([]);
    expect(signupChartData(undefined)).toEqual([]);
    const summary = buildStatsSummary({ ...demoStats(), dailySignups: [] }, []);
    expect(snapshotChartData(summary)).toEqual([]);
    expect(signupChartData(summary)).toEqual([]);
    expect(growthDescription(null)).toBe(
      "Not enough snapshots yet — the api Worker records one per day, and growth appears once two exist.",
    );
  });

  it("sorts and maps without mutating the summary", () => {
    const snapshots = demoSnapshots().reverse();
    const stats = demoStats();
    stats.dailySignups.reverse();
    const summary = buildStatsSummary(stats, snapshots);
    const before = JSON.stringify(summary);
    expect(snapshotChartData(summary)).toEqual(
      [...snapshots]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((s) => ({ date: s.date, total: s.totalUsers })),
    );
    expect(signupChartData(summary)).toEqual(
      [...stats.dailySignups]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((s) => ({ date: s.date, count: s.count })),
    );
    expect(JSON.stringify(summary)).toBe(before);
  });

  it("handles single points and formats growth including zero and negative change", () => {
    const summary = buildStatsSummary(demoStats(), demoSnapshots().slice(0, 1));
    expect(snapshotChartData(summary)).toHaveLength(1);
    const growth = {
      firstDate: "2026-01-01",
      latestDate: "2026-01-02",
      firstTotal: 0,
      latestTotal: 0,
      delta: 0,
      deltaPercent: null,
      spanDays: 1,
    };
    expect(growthDescription(growth)).toBe(
      "0 users on 2026-01-01 → 0 on 2026-01-02 (+0 over 1 days, from daily snapshots)",
    );
    expect(
      growthDescription({
        ...growth,
        firstTotal: 10,
        latestTotal: 5,
        delta: -5,
        deltaPercent: -50,
      }),
    ).toBe(
      "10 users on 2026-01-01 → 5 on 2026-01-02 (-5, -50.0% over 1 days, from daily snapshots)",
    );
  });
});
