/**
 * Postgres connection settings. Hosting gives one DATABASE_URL; otherwise the PG* variables.
 * With neither, development and tests use the local container from docker-compose.dev.yml.
 * Set PGSSL=true for hosts that require SSL from outside their network.
 */
export function dbConfig() {
  const ssl = process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false;
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL, ssl };
  if (!process.env.PGHOST && process.env.NODE_ENV === "production") {
    throw new Error("Set DATABASE_URL or PGHOST in production.");
  }
  return {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 54329),
    database: process.env.PGDATABASE || (process.env.NODE_ENV === "test" ? "replybek_test" : "replybek"),
    user: process.env.PGUSER || "replybek",
    password: process.env.PGPASSWORD || "replybek",
    ssl,
  };
}
