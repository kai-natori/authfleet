import { describe, expect, it } from "vitest";
import { InMemoryProjectRepository } from "../src/memory-repo";
import { runSnapshotJob } from "../src/snapshots";
import { buildStatsSummary, growthFromSnapshots, sumSignupWindow } from "../src/stats";
import type { SnapshotRecord } from "../src/types";

describe("stats", () => {
  const now = new Date("2026-11-15T12:00:00.000Z");

  it("sums signup windows inclusively", () => {
    const daily = [
      { date: "2026-11-15", count: 1 },
      { date: "2026-11-09", count: 2 },
      { date: "2026-11-08", count: 4 },
      { date: "2026-10-20", count: 8 },
    ];
    expect(sumSignupWindow(daily, 7, now)).toBe(3);
    expect(sumSignupWindow(daily, 30, now)).toBe(15);
  });

  it("computes growth from snapshots", () => {
    const snaps: SnapshotRecord[] = [
      { id: "1", projectId: "p", date: "2026-11-01", totalUsers: 100, createdAt: "" },
      { id: "2", projectId: "p", date: "2026-11-15", totalUsers: 150, createdAt: "" },
    ];
    const growth = growthFromSnapshots(snaps);
    expect(growth?.delta).toBe(50);
    expect(growth?.deltaPercent).toBe(50);
    expect(growth?.spanDays).toBe(14);
    expect(growthFromSnapshots(snaps.slice(0, 1))).toBeNull();
  });

  it("builds a summary", () => {
    const summary = buildStatsSummary(
      {
        totalUsers: 150,
        anonymousUsers: null,
        dailySignups: [{ date: "2026-11-15", count: 2 }],
        asOf: now.toISOString(),
      },
      [],
      now,
    );
    expect(summary.newLast7Days).toBe(2);
    expect(summary.newLast30Days).toBe(2);
    expect(summary.growth).toBeNull();
  });
});

describe("snapshot job", () => {
  it("snapshots real projects, skips demo, isolates failures", async () => {
    const repo = new InMemoryProjectRepository();
    const a = await repo.createProject({
      name: "A",
      cfAccountId: "x",
      d1DatabaseId: "1",
      tokenCiphertext: "c",
      tokenIv: "i",
      tokenHint: "h",
    });
    const b = await repo.createProject({
      name: "B",
      cfAccountId: "x",
      d1DatabaseId: "2",
      tokenCiphertext: "c",
      tokenIv: "i",
      tokenHint: "h",
    });
    await repo.createProject({
      name: "Demo",
      cfAccountId: "x",
      d1DatabaseId: "3",
      tokenCiphertext: "",
      tokenIv: "",
      tokenHint: "",
      isDemo: true,
    });

    const results = await runSnapshotJob({
      repo,
      now: new Date("2026-11-15T01:00:00.000Z"),
      readerFor: (project) => ({
        getTotalUsers: async () => {
          if (project.id === b.id) throw new Error("boom");
          return 42;
        },
      }),
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.projectId === a.id)?.ok).toBe(true);
    expect(results.find((r) => r.projectId === b.id)?.ok).toBe(false);
    const snaps = await repo.listSnapshots(a.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.totalUsers).toBe(42);
    expect(snaps[0]?.date).toBe("2026-11-15");
  });

  it("is idempotent per project per day", async () => {
    const repo = new InMemoryProjectRepository();
    const a = await repo.createProject({
      name: "A",
      cfAccountId: "x",
      d1DatabaseId: "1",
      tokenCiphertext: "c",
      tokenIv: "i",
      tokenHint: "h",
    });
    const deps = {
      repo,
      now: new Date("2026-11-15T01:00:00.000Z"),
      readerFor: () => ({ getTotalUsers: async () => 10 }),
    };
    await runSnapshotJob(deps);
    await runSnapshotJob({ ...deps, readerFor: () => ({ getTotalUsers: async () => 11 }) });
    const snaps = await repo.listSnapshots(a.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.totalUsers).toBe(11);
  });
});
