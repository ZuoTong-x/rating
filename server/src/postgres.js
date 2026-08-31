import "dotenv/config";
import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

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
  "id AS _id, name, originalFilename, importBatch, storageRoot, sourceZipPath, imageCount, categoryCount, status, taskStatus, deletionRequestedAt, createdAt, updatedAt, (SELECT COUNT(*) FROM subject_task_templates WHERE subject_task_templates.subjectId = subjects.id) AS taskTemplateCount";
export const projectSelectColumns = `
  projects.id AS _id, projects.name, projects.icon, projects.packageId, projects.taskStatus,
  projects.deletionRequestedAt, projects.createdAt, projects.updatedAt, subjects.name AS packageName,
  subjects.originalFilename AS packageFilename, subjects.imageCount, subjects.categoryCount, subjects.status AS packageStatus`;
export const imageSelectColumns = `id AS _id, subjectId, filename, originalPath, storagePath, thumbnailPath, mimeType, category, directory, isInfographic, prompt, catalogData, importBatch, scorer, ${scoreNumericFields.join(", ")}, ${scoreStateFields.join(", ")}, discomfort, comment, ratedAt, createdAt, updatedAt`;
export const userSelectColumns = "id, username, role, status, lastLoginAt, createdAt, updatedAt";

const defaultPoolMax = 24;
const configuredPoolMax = Number.parseInt(process.env.PG_POOL_MAX || "", 10);
const defaultStatementTimeout = 15000;
const configuredStatementTimeout = Number.parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "", 10);
const statementTimeout = Number.isInteger(configuredStatementTimeout) && configuredStatementTimeout > 0
  ? configuredStatementTimeout
  : defaultStatementTimeout;
const lockTimeout = Number.parseInt(process.env.PG_LOCK_TIMEOUT_MS || "2000", 10);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.isInteger(configuredPoolMax) && configuredPoolMax > 0 ? configuredPoolMax : defaultPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  options: `-c statement_timeout=${statementTimeout} -c lock_timeout=${Number.isInteger(lockTimeout) && lockTimeout > 0 ? lockTimeout : 2000} -c idle_in_transaction_session_timeout=60000`,
});
const transactionStorage = new AsyncLocalStorage();
const camelNames = new Map();

export function runWithDatabaseContext(callback) {
  return transactionStorage.run({ client: null }, callback);
}

for (const file of ["app.js", "services/admin-dashboard.js", "services/admin-scoring.js"]) {
  try {
    const source = await fs.readFile(new URL(`./${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
      camelNames.set(match[0].toLowerCase(), match[0]);
    }
  } catch {}
}

function mapRow(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camelNames.get(key) || key, value]));
}

function normalizeSql(source, named = false) {
  let sql = String(source);
  if (named) {
    const names = [];
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

function currentClient() {
  return transactionStorage.getStore()?.client || pool;
}

async function query(sql, params = []) {
  const result = await currentClient().query(sql, params);
  return { ...result, rows: result.rows.map(mapRow) };
}

class PreparedStatement {
  constructor(source) {
    const named = /@[A-Za-z_][A-Za-z0-9_]*/.test(source);
    this.named = named;
    ({ sql: this.sql, names: this.names } = normalizeSql(source, named));
  }

  params(values) {
    if (!this.named) return values;
    const object = values.length === 1 && values[0] && typeof values[0] === "object" ? values[0] : {};
    return this.names.map((name) => object[name]);
  }

  async get(...values) {
    const result = await query(this.sql, this.params(values));
    return result.rows[0];
  }

  async all(...values) {
    const result = await query(this.sql, this.params(values));
    return result.rows;
  }

  async run(...values) {
    const result = await query(this.sql, this.params(values));
    return { changes: result.rowCount, lastInsertRowid: null };
  }
}

async function exec(sql) {
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
  prepare(source) {
    return new PreparedStatement(source);
  },
  exec,
};

const schema = await fs.readFile(new URL("./postgres-schema.sql", import.meta.url), "utf8");
await pool.query(schema);

export { pool };
