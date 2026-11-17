import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

// `--test` migrates the test database instead (used by `npm test`).
if (process.argv.includes("--test")) process.env.NODE_ENV = "test";
const { dbConfig } = await import("../src/core/db-config.js");

const { Client } = pkg;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sql");
// The platform's schema first, then the CRM's files in name order (00-core, 10-booking, 20-store).
// Every file can run again and again.
const crm = fs.readdirSync(path.join(dir, "crm")).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join("crm", f));
const files = ["schema.sql", ...crm];

const client = new Client(dbConfig());
await client.connect();
try {
  for (const file of files) {
    try {
      await client.query(fs.readFileSync(path.join(dir, file), "utf-8"));
    } catch (e) {
      e.message = `sql/${file}: ${e.message}`;
      throw e;
    }
  }
  console.log(`Database schema is up to date (${client.database}): ${files.join(", ")}.`);
} finally {
  await client.end();
}
