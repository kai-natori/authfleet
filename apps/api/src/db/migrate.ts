import { migrations } from "./migrations.generated";

const initialized = new WeakMap<D1Database, Promise<void>>();

async function appliedNames(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  return new Set(rows.results.map((row) => row.name));
}

async function migrate(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`,
    )
    .run();
  let applied = await appliedNames(db);
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    const statements = migration.sql
      .split("--> statement-breakpoint")
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => db.prepare(sql));
    if (migration.name === "0001_lazy_cloak.sql") {
      // D1 keeps foreign keys enabled inside batches. The legacy SQL rebuilds
      // projects, which cascades into snapshots. Preserve them in the same
      // transaction without changing SQL that installations already applied.
      statements.unshift(
        db.prepare("CREATE TABLE __authfleet_snapshot_backup AS SELECT * FROM snapshots"),
      );
      statements.push(
        db.prepare(
          `INSERT INTO snapshots (id, project_id, date, total_users, created_at)
           SELECT id, project_id, date, total_users, created_at FROM __authfleet_snapshot_backup`,
        ),
        db.prepare("DROP TABLE __authfleet_snapshot_backup"),
      );
    }
    statements.push(db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name));
    try {
      await db.batch(statements);
    } catch (error) {
      applied = await appliedNames(db);
      if (!applied.has(migration.name)) throw error;
    }
  }
}

export function ensureMigrations(db: D1Database): Promise<void> {
  let pending = initialized.get(db);
  if (!pending) {
    pending = migrate(db).catch((error) => {
      initialized.delete(db);
      throw error;
    });
    initialized.set(db, pending);
  }
  return pending;
}
