import "dotenv/config";
import { initializeSchema, pool } from "./postgres.js";

try {
  console.info("Schema migration started");
  await initializeSchema();
  console.info("Schema migration completed");
} finally {
  await pool.end().catch(() => {});
}
