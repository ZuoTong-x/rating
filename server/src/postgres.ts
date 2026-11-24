import "dotenv/config";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;
pg.types.setTypeParser(20, (value) => Number(value));

export const scoreNumericFields = [
  "overall", "creativity", "mood", "composition", "color", "lighting", "realism", "detail",
  "promptAlignment", "textCorrectness", "anatomyNormality", "informationClarity", "designQuality", "typography",
];
export const skippableScoreFields = [
  "promptAlignment", "textCorrectness", "anatomyNormality", "informationClarity", "designQuality", "typography",
];
export const scoreStateFields = skippableScoreFields.map((field) => `${field}State`);
export const scoreFilterKeys = new Set(scoreNumericFields);
export const subjectSelectColumns =
  `id AS _id, name, originalFilename, importBatch, storageRoot, sourceZipPath,
   imageCount, categoryCount, status, taskStatus, deletionRequestedAt, createdAt, updatedAt,
   COALESCE(
     (SELECT taskTemplateCount FROM subject_task_template_stats WHERE subject_task_template_stats.subjectId = subjects.id),
     (SELECT COUNT(*) FROM subject_task_templates WHERE subject_task_templates.subjectId = subjects.id)
   ) AS taskTemplateCount`;
export const projectSelectColumns = `
  projects.id AS _id, projects.name, projects.icon, projects.packageId, projects.taskStatus, projects.tasksLocked,
  projects.deletionRequestedAt, projects.createdAt, projects.updatedAt, subjects.name AS packageName,
  subjects.originalFilename AS packageFilename, subjects.imageCount, subjects.categoryCount, subjects.status AS packageStatus`;
export const imageSelectColumns = `id AS _id, subjectId, filename, originalPath, storagePath, thumbnailPath, mimeType, category, directory, isInfographic, prompt, catalogData, importBatch, scorer, ${scoreNumericFields.join(", ")}, ${scoreStateFields.join(", ")}, discomfort, comment, ratedAt, createdAt, updatedAt`;
export const userSelectColumns = "id, username, role, status, mustChangePassword, lastLoginAt, createdAt, updatedAt";

const isTaskGenerationWorker = process.env.TASK_GENERATION_WORKER === "1";
const isThumbnailWorker = process.env.THUMBNAIL_WORKER === "1";
const isBackgroundWorker = isTaskGenerationWorker || isThumbnailWorker;
const defaultPoolMax = 24;
const configuredPoolMax = Number.parseInt(process.env.PG_POOL_MAX || "", 10);
const configuredWorkerPoolMax = Number.parseInt(
  process.env.PG_TASK_GENERATION_POOL_MAX || "",
  10,
);
const configuredThumbnailWorkerPoolMax = Number.parseInt(
  process.env.THUMBNAIL_WORKER_PG_POOL_MAX || "",
  10,
);
const databaseUrl = process.env.DATABASE_URL || (
  process.env.POSTGRES_DB && process.env.POSTGRES_USER && process.env.POSTGRES_PASSWORD
    ? `postgresql://${encodeURIComponent(process.env.POSTGRES_USER)}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${process.env.POSTGRES_HOST || "127.0.0.1"}:${process.env.POSTGRES_PORT || "5432"}/${encodeURIComponent(process.env.POSTGRES_DB)}`
    : undefined
);
const defaultStatementTimeout = 60000;
const configuredStatementTimeout = Number.parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "", 10);
const statementTimeout = Number.isInteger(configuredStatementTimeout) && configuredStatementTimeout > 0
  ? configuredStatementTimeout
  : defaultStatementTimeout;
const lockTimeout = Number.parseInt(process.env.PG_LOCK_TIMEOUT_MS || "2000", 10);
const pool = new Pool({
  connectionString: databaseUrl,
  max: isTaskGenerationWorker
    ? (
      Number.isInteger(configuredWorkerPoolMax) && configuredWorkerPoolMax > 0
        ? configuredWorkerPoolMax
        : 4
    )
    : isThumbnailWorker
      ? (
        Number.isInteger(configuredThumbnailWorkerPoolMax) && configuredThumbnailWorkerPoolMax > 0
          ? configuredThumbnailWorkerPoolMax
          : 4
      )
    : (
      Number.isInteger(configuredPoolMax) && configuredPoolMax > 0
        ? configuredPoolMax
        : defaultPoolMax
    ),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  options: `-c statement_timeout=${statementTimeout} -c lock_timeout=${Number.isInteger(lockTimeout) && lockTimeout > 0 ? lockTimeout : 2000} -c idle_in_transaction_session_timeout=60000`,
});
const transactionStorage = new AsyncLocalStorage<{ client: PoolClient | null }>();
const camelNames = new Map<string, string>();

export function runWithDatabaseContext<T>(callback: () => T): T {
  return transactionStorage.run({ client: null }, callback);
}

async function collectCamelNames(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectCamelNames(file);
    } else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) {
      const source = await fs.readFile(file, "utf8");
      for (const match of source.matchAll(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
        camelNames.set(match[0].toLowerCase(), match[0]);
      }
    }
  }
}

await collectCamelNames(path.dirname(fileURLToPath(import.meta.url)));
// filename is already the database/API field name. A local `fileName` variable
// must not change its casing when rows are mapped from PostgreSQL.
camelNames.set("filename", "filename");

function mapRow(row: Record<string, unknown>) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camelNames.get(key) || key, value]));
}

function normalizeSql(source: string, named = false) {
  let sql = String(source);
  if (named) {
    const names: string[] = [];
    sql = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      const index = names.indexOf(name);
      if (index >= 0) return `$${index + 1}`;
      names.push(name);
      return `$${names.length}`;
    });
    return { sql, names };
  }
  let index = 0;
  sql = sql.replace(/\?/g, () => `$${++index}`);
  return { sql, names: null };
}

function currentClient(): PoolClient | InstanceType<typeof Pool> {
  return transactionStorage.getStore()?.client || pool;
}

async function query(sql: string, params: unknown[] = []) {
  const result = await currentClient().query(sql, params);
  return { ...result, rows: result.rows.map(mapRow) };
}

class PreparedStatement {
  readonly named: boolean;
  readonly sql: string;
  readonly names: string[] | null;

  constructor(source: string) {
    const named = /@[A-Za-z_][A-Za-z0-9_]*/.test(source);
    this.named = named;
    ({ sql: this.sql, names: this.names } = normalizeSql(source, named));
  }

  params(values: unknown[]): unknown[] {
    if (!this.named) return values;
    const object = values.length === 1 && values[0] && typeof values[0] === "object"
      ? values[0] as Record<string, unknown>
      : {};
    return (this.names || []).map((name) => object[name]);
  }

  async get(...values: unknown[]) {
    const result = await query(this.sql, this.params(values));
    return result.rows[0];
  }

  async all(...values: unknown[]) {
    const result = await query(this.sql, this.params(values));
    return result.rows;
  }

  async run(...values: unknown[]) {
    const result = await query(this.sql, this.params(values));
    return { changes: result.rowCount, lastInsertRowid: null };
  }
}

async function exec(sql: string) {
  const statement = String(sql).trim();
  if (/^BEGIN\b/i.test(statement)) {
    const context = transactionStorage.getStore();
    if (!context) throw new Error("数据库事务必须在数据库上下文中启动");
    if (context.client) throw new Error("数据库事务已在进行中");
    const client = await pool.connect();
    await client.query("BEGIN");
    context.client = client;
    return;
  }
  if (/^COMMIT\b/i.test(statement) || /^ROLLBACK\b/i.test(statement)) {
    const context = transactionStorage.getStore();
    const client = context?.client;
    if (!client) return;
    try {
      await client.query(statement);
    } finally {
      client.release();
      context.client = null;
    }
    return;
  }
  return query(normalizeSql(statement).sql);
}

export const db = {
  prepare(source: string) {
    return new PreparedStatement(source);
  },
  exec,
};

export async function initializeSchema() {
  const migrations = [
    "0001_legacy_schema.sql",
    "0002_thumbnail_subject_stats.sql",
    "0003_drop_duplicate_project_package_index.sql",
  ];
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(438338, 1) AS acquired");
    if (!lock.rows[0]?.acquired) throw new Error("另一个 Schema 迁移正在执行");
    locked = true;
    const migrationTable = await client.query(
      "SELECT to_regclass('public.schema_migrations') AS relation",
    );
    if (!migrationTable.rows[0]?.relation) {
      await client.query(`CREATE TABLE public.schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        appliedat timestamptz NOT NULL DEFAULT now()
      )`);
    }
    const applied = new Map((await client.query(
      "SELECT version, checksum FROM public.schema_migrations",
    )).rows.map((row) => [row.version, row.checksum]));

    for (const filename of migrations) {
      const version = filename.slice(0, 4);
      const sql = await fs.readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      if (applied.has(version)) {
        if (applied.get(version) !== checksum) {
          throw new Error(`Schema 迁移 ${version} 的内容与已执行版本不一致`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        if (version === "0001" && await hasLegacySchema(client, sql)) {
          console.info("Existing database schema adopted as migration 0001");
        } else {
          console.info(`Applying schema migration ${filename}`);
          await client.query(sql);
        }
        await client.query(
          "INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)",
          [version, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Schema 迁移 ${filename} 失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(438338, 1)").catch(() => {});
    client.release();
  }
}

async function hasLegacySchema(client: PoolClient, baselineSql: string) {
  const required = [...new Set([...baselineSql.matchAll(
    /\bcreate\s+table\s+if\s+not\s+exists\s+([a-z_][a-z_0-9]*)\s*\(/gi,
  )].map((match) => match[1].toLowerCase()))];
  const result = await client.query(`
    SELECT name, to_regclass('public.' || name) IS NOT NULL AS present
    FROM unnest($1::text[]) AS name
  `, [required]);
  const present = result.rows.filter((row) => row.present).map((row) => row.name);
  if (!present.length) return false;
  if (present.length !== required.length) {
    throw new Error(`现有数据库结构不完整，拒绝自动接管；缺少：${required.filter((name) => !present.includes(name)).join(", ")}`);
  }
  return true;
}

if (!isBackgroundWorker && process.env.RUN_SCHEMA_INIT !== "0") {
  console.info("Database schema initialization started");
  await initializeSchema();
  console.info("Database schema initialization completed");
}

export { pool };
