import { readdir, readFile } from "node:fs/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureMigrations } from "../src/db/migrate";
import { migrations } from "../src/db/migrations.generated";
import worker, { type Env } from "../src/index";

describe("registry migrations", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: "export default { fetch() { return new Response('ok'); } };",
        compatibilityDate: "2025-09-02",
        d1Databases: ["DB"],
      }),
    );
    const binding = (await mf.getD1Database("DB")) as unknown as D1Database;
    db = {
      prepare: binding.prepare.bind(binding),
      batch: binding.batch.bind(binding),
    } as D1Database;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mf.dispose();
  });

  async function seed(count: number) {
    await db
      .prepare(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`)
      .run();
    for (const migration of migrations.slice(0, count)) {
      await db.batch([
        ...migration.sql
          .split("--> statement-breakpoint")
          .filter((sql) => sql.trim())
          .map((sql) => db.prepare(sql)),
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name),
      ]);
    }
  }

  it("bundles exactly the SQL files on disk", async () => {
    const directory = new URL("../migrations/", import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    expect(migrations).toEqual(
      await Promise.all(
        names.map(async (name) => ({
          name,
          sql: await readFile(new URL(name, directory), "utf8"),
        })),
      ),
    );
  });

  it("creates all tables on a fresh DB and caches initialization", async () => {
    const first = ensureMigrations(db);
    expect(ensureMigrations(db)).toBe(first);
    await first;
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(
      expect.arrayContaining(["projects", "snapshots", "d1_migrations"]),
    );
    expect((await db.prepare("SELECT * FROM d1_migrations").all()).results).toHaveLength(
      migrations.length,
    );
    const batch = vi.spyOn(db, "batch");
    await ensureMigrations(db);
    expect(batch).not.toHaveBeenCalled();
  });

  it("recognizes pre-existing Wrangler history without applying SQL", async () => {
    await seed(migrations.length);
    const batch = vi.spyOn(db, "batch");
    await ensureMigrations(db);
    expect(batch).not.toHaveBeenCalled();
  });

  it("applies only 0001 when 0000 is recorded", async () => {
    await seed(1);
    const batch = vi.spyOn(db, "batch");
    await ensureMigrations(db);
    expect(batch).toHaveBeenCalledTimes(1);
    const columns = await db.prepare("PRAGMA table_info(projects)").all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).toEqual(
      expect.arrayContaining(["type", "base_url"]),
    );
  });

  it("preserves projects and snapshots when upgrading a populated v1 registry", async () => {
    await seed(1);
    await db
      .prepare(
        `INSERT INTO projects VALUES
       ('project', 'Existing app', 'account', 'database', 'ciphertext', 'iv',
        'hint', 0, '2026-11-20', '2026-11-20')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO snapshots VALUES
       ('snapshot', 'project', '2026-11-20', 42, '2026-11-20')`,
      )
      .run();
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce((statements) =>
      batch([...statements, db.prepare("INSERT INTO missing_table VALUES (1)")]),
    );
    await expect(ensureMigrations(db)).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM snapshots").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first()).toEqual({ n: 1 });
    expect(
      await db
        .prepare("SELECT name FROM sqlite_master WHERE name = '__authfleet_snapshot_backup'")
        .first(),
    ).toBeNull();
    await ensureMigrations(db);
    expect((await db.prepare("SELECT * FROM snapshots").all()).results).toEqual([
      {
        id: "snapshot",
        project_id: "project",
        date: "2026-11-20",
        total_users: 42,
        created_at: "2026-11-20",
      },
    ]);
    expect(
      await db.prepare("SELECT type, token_ciphertext, token_iv FROM projects").first(),
    ).toEqual({ type: "d1", token_ciphertext: "ciphertext", token_iv: "iv" });
  });

  it("retries failures without recording a failed migration", async () => {
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("simulated failure"));
    await expect(ensureMigrations(db)).rejects.toThrow("simulated failure");
    expect((await db.prepare("SELECT * FROM d1_migrations").all()).results).toHaveLength(0);
    await ensureMigrations(db);
    expect((await db.prepare("SELECT * FROM d1_migrations").all()).results).toHaveLength(
      migrations.length,
    );
  });

  it("accepts a concurrent isolate completing a migration", async () => {
    const original = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await original(statements);
      throw new Error("another isolate already committed");
    });
    await ensureMigrations(db);
    expect((await db.prepare("SELECT * FROM d1_migrations").all()).results).toHaveLength(
      migrations.length,
    );
  });

  it("wires API initialization but leaves health independent", async () => {
    const env: Env = {
      DB: db,
      TOKEN_ENCRYPTION_KEY: "",
      AUTHFLEET_OPERATOR_EMAILS: "op@example.com",
    };
    expect((await worker.fetch(new Request("https://api/health"), env)).status).toBe(200);
    expect(
      (await db.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").all()).results,
    ).toHaveLength(0);
    expect(
      (
        await worker.fetch(
          new Request("https://api/api/projects", {
            headers: { "x-authfleet-operator": "op@example.com" },
          }),
          env,
        )
      ).status,
    ).toBe(200);
  });

  it("initializes before scheduled work and stops on failure", async () => {
    const env: Env = { DB: db, TOKEN_ENCRYPTION_KEY: "" };
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("migration failed"));
    await expect(worker.scheduled({} as ScheduledController, env, ctx)).rejects.toThrow(
      "migration failed",
    );
    await expect(worker.scheduled({} as ScheduledController, env, ctx)).rejects.toThrow(
      "TOKEN_ENCRYPTION_KEY",
    );
    expect((await db.prepare("SELECT * FROM d1_migrations").all()).results).toHaveLength(
      migrations.length,
    );
  });
});
