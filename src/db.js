import pkg from "pg";
import { dbConfig } from "./dbConfig.js";
const { Pool } = pkg;

const pool = new Pool(dbConfig());

export const query = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();

/** Runs `fn(client)` in a transaction; rolls back if it throws. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export const closeDb = () => pool.end();

export default { query, getClient, tx };
