// Live updates. Postgres announces every change to a conversation (replybek_notify in
// sql/schema.sql), one connection per process listens, and Server-Sent Events pass it on to the
// dashboards and widgets that have a stream open. An event only says which conversation changed;
// screens then fetch it the usual way, with the usual permission checks. Screens keep a slow poll
// as a fallback, so a dropped connection only makes updates slower, never lost.
// Signals (someone is typing) are different: nothing is stored, the event carries what screens
// show, and it goes out at once as a named event (`event: typing`).
// The CRM's tables announce themselves the same way (sql/crm/00-core.sql, crm_watch) as
// {"w": workspace, "t": "crm", "k": snapshot key, "i"|"d": [row ids] | "many", "r": rev}. Those go
// out as their own named event (`event: crm`, data {"k": [keys]}), so the inbox's screens, which
// read unnamed messages, never see them. They reach the workspace's stream and the CRM's own
// (`crm:<workspace>`); a stream opened with `rows` also says which rows (see crmEvent).
import { EventEmitter } from "node:events";
import pkg from "pg";
import { dbConfig } from "./db-config.js";
import { query } from "./db.js";

const CHANNEL = "replybek_events";
const HEARTBEAT_MS = 25 * 1000;      // proxies (Cloudflare: 100 s) close connections that go quiet
const MAX_STREAM_MS = 30 * 60 * 1000; // streams end now and then; clients reconnect on their own
const BATCH_MS = 120;                 // a reply touches several rows: send one event for them
const MAX_IDS = 200;                  // more rows of one key in one event: "many", the screen reads the key again

const bus = new EventEmitter();
bus.setMaxListeners(0);
const streams = new Set();
let client = null;
let starting = null;
let retryTimer = null;
let connectedBefore = false;
let stopped = false;

async function connect() {
  const c = new pkg.Client(dbConfig());
  c.on("notification", (msg) => {
    let e;
    try {
      e = JSON.parse(msg.payload);
    } catch {
      return;
    }
    if (e.s) return void bus.emit(e.k, e); // a signal, for one stream key
    if (e.t === "crm") {
      bus.emit(`w:${e.w}`, e);
      return void bus.emit(`crm:${e.w}`, e);
    }
    if (e.w) bus.emit(`w:${e.w}`, e);
    if (e.c) bus.emit(`c:${e.c}`, e);
  });
  c.on("error", () => drop(c));
  c.on("end", () => drop(c));
  try {
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
  } catch (e) {
    c.removeAllListeners();
    c.end().catch(() => {});
    throw e;
  }
  if (stopped) {
    c.removeAllListeners();
    await c.end().catch(() => {});
    return;
  }
  client = c;
  // Anything that happened while we weren't listening is unknown: tell every screen to catch up.
  if (connectedBefore) for (const name of bus.eventNames()) bus.emit(name, { resync: true });
  connectedBefore = true;
}

function drop(c) {
  if (client !== c) return;
  client = null;
  starting = null;
  c.removeAllListeners();
  c.end().catch(() => {});
  retryLater(1000);
}

function retryLater(ms) {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    listen().catch(() => {});
  }, ms);
  retryTimer.unref();
}

/** Starts listening if this process isn't yet. Resolves once events flow. */
function listen() {
  if (stopped) return Promise.resolve();
  if (client) return Promise.resolve();
  if (!starting) {
    starting = connect().catch((e) => {
      starting = null;
      console.error(`Live updates: can't listen (${e.message}); retrying`);
      retryLater(5000);
      throw e;
    });
  }
  return starting;
}

/** Calls fn(event) for each event on the given keys (`w:<workspace>`, `c:<conversation>`, `crm:<workspace>`). Returns unsubscribe. */
export function subscribe(keys, fn) {
  for (const k of keys) bus.on(k, fn);
  listen().catch(() => {});
  return () => {
    for (const k of keys) bus.off(k, fn);
  };
}

/**
 * What one batch of CRM announcements says, gathered as they arrive. `data(rows)`:
 *   { k: [snapshot keys] }, and with `rows` also
 *   ids:  { [key]: [row ids added or changed] | "many" }   a key that names no rows (settings) is not in it
 *   del:  { [key]: [row ids deleted] }
 *   revs: [the writes' revs]                                only when every change came from a write
 * Row contents never travel: the screen fetches snapshot?only=<key>&ids=<ids>.
 */
function crmEvent() {
  const keys = new Map();
  const revs = new Set();
  let unknownRev = false;
  const take = (e) => {
    const k = keys.get(e.k) || { ids: new Set(), del: new Set(), many: false, named: false };
    keys.set(e.k, k);
    if (e.r === undefined) unknownRev = true;
    else revs.add(e.r);
    for (const [list, sent] of [[k.ids, e.i], [k.del, e.d]]) {
      if (sent === undefined) continue;
      k.named = true;
      if (sent === "many") k.many = true;
      else for (const id of sent) list.add(id);
    }
  };
  const data = (rows) => {
    if (!rows) return { k: [...keys.keys()] };
    const out = { k: [...keys.keys()], ids: {}, del: {} };
    for (const [key, k] of keys) {
      if (!k.named) continue;
      for (const id of k.del) k.ids.delete(id);
      if (k.many || k.ids.size + k.del.size > MAX_IDS) {
        out.ids[key] = "many";
        continue;
      }
      if (k.ids.size) out.ids[key] = [...k.ids];
      if (k.del.size) out.del[key] = [...k.del];
    }
    if (!unknownRev) out.revs = [...revs].sort((a, b) => a - b);
    return out;
  };
  return { take, data, get size() { return keys.size; } };
}

/**
 * Turns this response into an event stream for the given keys. `accept(event)` filters what this
 * viewer is told about. Each message is `data: {"c": [conversation ids]}`; `{"resync": true}`
 * means "fetch everything". CRM changes come as `event: crm` with `data: {"k": [snapshot keys]}`,
 * and with `rows` also which rows changed (crmEvent above). The first message, `event: ready`,
 * comes once events flow, so a client that fetches on ready can't miss a change made while it was connecting.
 */
export async function stream(req, res, keys, accept = () => true, { rows = false } = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  let changed = new Set();
  let crm = crmEvent();
  let resync = false;
  let batch = null;
  const flush = () => {
    batch = null;
    if (resync || changed.size) res.write(`data: ${JSON.stringify(resync ? { resync: true } : { c: [...changed] })}\n\n`);
    // After a resync the screen fetches everything anyway.
    if (crm.size && !resync) res.write(`event: crm\ndata: ${JSON.stringify(crm.data(rows))}\n\n`);
    changed = new Set();
    crm = crmEvent();
    resync = false;
  };
  const unsubscribe = subscribe(keys, (e) => {
    if (e.s) return void res.write(`event: ${e.s}\ndata: ${JSON.stringify(e.d)}\n\n`);
    if (e.t === "crm") crm.take(e);
    else if (e.resync) resync = true;
    else if (accept(e)) changed.add(e.c);
    else return;
    batch ??= setTimeout(flush, BATCH_MS);
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  const lifetime = setTimeout(() => res.end(), MAX_STREAM_MS);
  const entry = { res, keys };
  streams.add(entry);
  const close = () => {
    unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    clearTimeout(batch);
    streams.delete(entry);
  };
  req.on("close", close);
  res.on("close", close);
  await listen().catch(() => {});
  if (!res.writableEnded) res.write("event: ready\ndata: {}\n\n");
}

/**
 * Sends a passing signal to the screens listening on `key` (`w:<workspace>` or `c:<conversation>`):
 * they get `event: <name>` with `data`. Through Postgres, so it reaches every API process.
 */
export async function signal(key, name, data) {
  await query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ s: name, k: key, d: data })]);
}

/** Whether someone has this workspace's dashboard open right now. */
export const watching = (workspaceId) => [...streams].some((e) => e.keys.includes(`w:${workspaceId}`));

/** Ends open streams and stops listening (shutdown and tests). */
export async function stopEvents() {
  stopped = true;
  clearTimeout(retryTimer);
  for (const { res } of streams) res.end();
  const c = client;
  client = null;
  if (c) {
    c.removeAllListeners();
    await c.end().catch(() => {});
  }
}
