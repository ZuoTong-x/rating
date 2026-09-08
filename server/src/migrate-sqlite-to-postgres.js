import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";

const { Client } = pg;
const sqlitePath = path.resolve(process.env.SQLITE_PATH || "data/image-rating.sqlite");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const client = new Client({ connectionString });
const migrationOrder = [
  "users",
  "import_jobs",
  "schema_meta",
  "subjects",
  "teams",
  "projects",
  "task_generation_jobs",
  "user_sessions",
  "project_packages",
  "user_teams",
  "project_teams",
  "user_projects",
  "images",
  "project_task_stats",
  "scorer_task_stats",
  "rating_tasks",
  "subject_task_templates",
  "rating_task_items",
  "subject_task_template_items",
  "image_pair_edges",
  "feedbacks",
  "feedback_messages",
];
const timestampColumns = new Set([
  "createdat",
  "updatedat",
  "lastloginat",
  "expiresat",
  "lastseenat",
  "deletionrequestedat",
  "ratedat",
  "startedat",
  "completedat",
  "editedat",
  "lastrolledbackat",
  "submittedat",
  "repliedat",
]);

function quoteIdentifier(value) {
  return `"${String(value).toLowerCase().replaceAll('"', '""')}"`;
}

function sqliteTables(targetTables) {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  return migrationOrder.filter((table) => tables.includes(table) && targetTables.has(table));
}

function migrateValue(table, column, value) {
  if (!timestampColumns.has(String(column).toLowerCase())) return value;
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp in ${table}.${column}: ${value}`);
  }
  return date;
}

async function ensureNativeTimestampColumns() {
  const result = await client.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND column_name = ANY($1::text[])
       AND data_type <> 'timestamp with time zone'`,
    [[...timestampColumns]],
  );
  for (const { table_name: table, column_name: column } of result.rows) {
    await client.query(
      `ALTER TABLE ${quoteIdentifier(table)}
       ALTER COLUMN ${quoteIdentifier(column)} TYPE timestamptz
       USING NULLIF(BTRIM(${quoteIdentifier(column)}::text), '')::timestamptz`,
    );
  }
}

async function migrateTable(table, targetColumns) {
  const columns = sqlite
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((column) => column.name);
  const migratedColumns = columns.filter((column) => targetColumns.has(column.toLowerCase()));
  const rows = sqlite.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
  if (!rows.length) return { table, rows: 0 };

  const names = migratedColumns.map(quoteIdentifier).join(", ");
  let migratedRows = 0;
  for (const row of rows) {
    const values = migratedColumns.map((column) => migrateValue(table, column, row[column]));
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    const result = await client.query(
      `INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders})`,
      values,
    );
    if (result.rowCount !== 1) throw new Error(`Failed to migrate ${table} row`);
    migratedRows += 1;
  }
  return { table, rows: migratedRows };
}

async function loadTargetTableColumns() {
  const result = await client.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()`,
  );
  const tables = new Set();
  const columns = new Map();
  for (const { table_name: table, column_name: column } of result.rows) {
    tables.add(table);
    if (!columns.has(table)) columns.set(table, new Set());
    columns.get(table).add(column);
  }
  return { tables, columns };
}

async function rebuildTaskStats() {
  await client.query("DELETE FROM project_task_stats");
  await client.query(`
    INSERT INTO project_task_stats
      (projectid, taskversion, total, pending, assigned, completed, updatedat)
    SELECT projectid, taskversion, COUNT(*),
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),
           SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END),
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),
           COALESCE(MAX(updatedat), CURRENT_TIMESTAMP)
    FROM rating_tasks
    WHERE projectid IS NOT NULL
    GROUP BY projectid, taskversion
  `);

  await client.query("DELETE FROM scorer_task_stats");
  await client.query(`
    INSERT INTO scorer_task_stats
      (scorer, taskversion, projectid, assigned, completed, updatedat)
    SELECT scorer, taskversion, COALESCE(projectid, ''),
           SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END),
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),
           COALESCE(MAX(updatedat), CURRENT_TIMESTAMP)
    FROM rating_tasks
    WHERE scorer IS NOT NULL
      AND BTRIM(scorer) <> ''
      AND status IN ('assigned', 'completed')
    GROUP BY scorer, taskversion, COALESCE(projectid, '')
  `);
}

await client.connect();
try {
  await client.query("BEGIN");
  // Rebuild the indexes whose PostgreSQL ordering differs from SQLite.
  await client.query("DROP INDEX IF EXISTS idx_rating_tasks_project, idx_rating_tasks_export");
  const schemaPath = new URL("./postgres-schema.sql", import.meta.url);
  await client.query(await fs.readFile(schemaPath, "utf8"));
  const target = await loadTargetTableColumns();
  await ensureNativeTimestampColumns();
  await client.query("ALTER TABLE rating_tasks DISABLE TRIGGER trg_rating_tasks_stats");
  const results = [];
  for (const table of sqliteTables(target.tables)) {
    results.push(await migrateTable(table, target.columns.get(table)));
  }
  await rebuildTaskStats();
  await client.query("ALTER TABLE rating_tasks ENABLE TRIGGER trg_rating_tasks_stats");
  await client.query("COMMIT");
  await client.query("ANALYZE");
  for (const result of results) console.log(`${result.table}: ${result.rows}`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
  sqlite.close();
}
