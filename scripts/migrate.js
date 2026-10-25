import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

// `--test` migrates the test database instead (used by `npm test`).
if (process.argv.includes("--test")) process.env.NODE_ENV = "test";
const { dbConfig } = await import("../src/dbConfig.js");

const { Client } = pkg;
const dir = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(dir, "../sql/schema.sql"), "utf-8");

const client = new Client(dbConfig());
await client.connect();
try {
  await client.query(sql);
  console.log(`Database schema is up to date (${client.database}).`);
} finally {
  await client.end();
}
