-- Replybek CRM: what every CRM workspace has, whichever modules are on.
-- Runs after schema.sql (scripts/migrate.js runs every file in this folder in name order) and,
-- like it, can run again and again: IF NOT EXISTS, CREATE OR REPLACE.
-- The modules add their own files: 10-booking.sql, 20-store.sql.

-- ───── Packages ─────
-- What a workspace bought: the AI agent, the CRM or both. Workspaces made before the CRM have the agent.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS products TEXT[] NOT NULL DEFAULT '{agent}';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_products_known') THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_products_known
      CHECK (cardinality(products) > 0 AND products <@ ARRAY['agent', 'crm']::text[]);
  END IF;
END $$;

-- ───── Settings ─────
-- One row per CRM workspace, made the first time the CRM is opened (src/crm/db.js).
-- `data` holds everything a business edits in CRM settings, in the shapes the app reads:
-- modules, settings, sources, tags, fields, apptStages, orderStages, deliveryMethods,
-- paymentMethods, units, serviceCategories, productCategories.
CREATE TABLE IF NOT EXISTS crm_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  -- Goes up by one with every CRM write in the workspace. Each write locks this row first, so
  -- writes in one workspace happen one after another.
  rev BIGINT NOT NULL DEFAULT 1,
  -- The last order number given out.
  order_seq BIGINT NOT NULL DEFAULT 1000,
  -- Days and times in the CRM are the business's wall clock. This says where that clock is.
  timezone TEXT NOT NULL DEFAULT 'Asia/Tashkent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───── Branches ─────
-- Every workspace has one default branch from the start; rows that belong to a place carry
-- branch_id. The app shows nothing about branches until there are two.
CREATE TABLE IF NOT EXISTS crm_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Empty for the first branch: it goes by the workspace's name.
  name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lets other tables point at (workspace_id, branch_id), so a row can't name another workspace's branch.
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_branches_default ON crm_branches (workspace_id) WHERE is_default;

-- ───── Customers ─────
-- One list for the whole business, not per branch.
CREATE TABLE IF NOT EXISTS crm_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',      -- "+998901234567", or empty
  telegram TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',     -- an id from the workspace's sources, or "ai"
  tags TEXT[] NOT NULL DEFAULT '{}',   -- ids from the workspace's tags
  note TEXT NOT NULL DEFAULT '',
  fields JSONB NOT NULL DEFAULT '{}'::jsonb, -- { [fieldId]: value }, see fields.customer in the settings
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lets bookings and orders point at (workspace_id, customer_id): never another workspace's customer.
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS crm_customers_workspace ON crm_customers (workspace_id, created_at);
-- Two customers of one business can't share a phone number. Customers without one are fine.
CREATE UNIQUE INDEX IF NOT EXISTS crm_customers_phone ON crm_customers (workspace_id, phone) WHERE phone <> '';
-- A Telegram handle is kept bare ("jasur_k"), however it was typed (shared/customer.js
-- telegramHandle). Handles saved before that rule lose only the known prefixes: "@", "t.me/",
-- "https://t.me/" and a trailing "/". Anything else stays as it was.
UPDATE crm_customers SET telegram = regexp_replace(regexp_replace(regexp_replace(btrim(telegram), '^(https?://)?(www\.)?(t\.me|telegram\.me)/', '', 'i'), '^@+', ''), '/+$', '')
 WHERE telegram ~* '^\s|\s$|^@|^(https?://)?(www\.)?(t\.me|telegram\.me)/|/$';
-- A Telegram chat finds the customer the team saved with its handle, in any letter case.
DROP INDEX IF EXISTS crm_customers_telegram;
CREATE INDEX IF NOT EXISTS crm_customers_handle ON crm_customers (workspace_id, lower(telegram)) WHERE telegram <> '';

-- ───── Live updates ─────
-- Every CRM table says when it changed, on the same channel the inbox uses (replybek_notify in
-- schema.sql). src/core/events.js passes it on to open CRM screens, which then fetch
-- snapshot?only=<key>, or just the rows named (snapshot?only=<key>&ids=..., AS-BUILT-snapshot.md).
-- One announcement per statement and workspace (not one per row, so a step removed from a board
-- with 20,000 orders on it is one message):
--   {"w": workspace, "t": "crm", "k": snapshot key, "i": [ids] | "many", "r": rev}
--   {"w": workspace, "t": "crm", "k": snapshot key, "d": [ids] | "many", "r": rev}   rows deleted
-- `i`: the snapshot rows that were added or changed (an order line names its order, a variant or a
-- stock sum its product). `d`: rows of the key's own table that were deleted. More than 100 ids: "many".
-- `r`: the write's rev (src/crm/db.js sets crm.rev in every write), left out for changes made outside one.
-- Row contents never travel: screens fetch the rows by id. An UPDATE that changes nothing stays quiet.
-- Arguments: the key; the column naming the snapshot row ('id', 'order_id', ...); 'variant' when
-- that column is a variant id and the row is its product.
CREATE OR REPLACE FUNCTION crm_announce_rows() RETURNS trigger AS $$
DECLARE
  col TEXT := COALESCE(NULLIF(TG_ARGV[1], ''), 'id');
  gone BOOLEAN := TG_OP = 'DELETE' AND COALESCE(NULLIF(TG_ARGV[1], ''), 'id') = 'id';
  rev TEXT := NULLIF(current_setting('crm.rev', true), '');
  changed TEXT;
  named TEXT;
  r RECORD;
BEGIN
  changed := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT to_jsonb(n) AS j FROM new_rows n'
    WHEN 'DELETE' THEN 'SELECT to_jsonb(o) AS j FROM old_rows o'
    -- Rows that differ, as they were and as they are: a line moved to another order names both.
    ELSE '(SELECT to_jsonb(n) AS j FROM new_rows n EXCEPT SELECT to_jsonb(o) FROM old_rows o)
          UNION ALL (SELECT to_jsonb(o) FROM old_rows o EXCEPT SELECT to_jsonb(n) FROM new_rows n)'
  END;
  named := format('SELECT (j->>''workspace_id'')::uuid AS w, (j->>%L)::uuid AS x FROM (%s) t', col, changed);
  IF TG_ARGV[2] = 'variant' THEN
    named := format('SELECT c.w, v.product_id AS x FROM (%s) c JOIN crm_variants v ON v.workspace_id = c.w AND v.id = c.x', named);
  END IF;
  FOR r IN EXECUTE format('SELECT w, array_agg(DISTINCT x) AS ids FROM (%s) c WHERE x IS NOT NULL GROUP BY w', named) LOOP
    PERFORM pg_notify('replybek_events', json_strip_nulls(json_build_object(
      'w', r.w, 't', 'crm', 'k', TG_ARGV[0],
      CASE WHEN gone THEN 'd' ELSE 'i' END, CASE WHEN cardinality(r.ids) > 100 THEN to_json('many'::text) ELSE to_json(r.ids) END,
      'r', rev::bigint))::text);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- SELECT crm_watch('crm_order_lines', 'orders', 'order_id'): from now on the table announces its
-- changes under that snapshot key, naming the rows by that column (its own id when left out). The
-- table needs a workspace_id column. The one place these triggers are made: every CRM file calls it.
-- Before, crm_watch(tbl, key) made a row trigger named crm_notify that named only the key; it is
-- dropped here, and each call below and in the other files replaces that trigger.
DROP FUNCTION IF EXISTS crm_watch(TEXT, TEXT);
CREATE OR REPLACE FUNCTION crm_watch(tbl TEXT, key TEXT, col TEXT DEFAULT 'id', via TEXT DEFAULT '') RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS crm_notify ON %I', tbl);
  EXECUTE format('DROP TRIGGER IF EXISTS crm_announce_insert ON %I', tbl);
  EXECUTE format('DROP TRIGGER IF EXISTS crm_announce_update ON %I', tbl);
  EXECUTE format('DROP TRIGGER IF EXISTS crm_announce_delete ON %I', tbl);
  EXECUTE format('CREATE TRIGGER crm_announce_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows
                  FOR EACH STATEMENT EXECUTE FUNCTION crm_announce_rows(%L, %L, %L)', tbl, key, col, via);
  EXECUTE format('CREATE TRIGGER crm_announce_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
                  FOR EACH STATEMENT EXECUTE FUNCTION crm_announce_rows(%L, %L, %L)', tbl, key, col, via);
  EXECUTE format('CREATE TRIGGER crm_announce_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows
                  FOR EACH STATEMENT EXECUTE FUNCTION crm_announce_rows(%L, %L, %L)', tbl, key, col, via);
END;
$$ LANGUAGE plpgsql;

SELECT crm_watch('crm_customers', 'customers');
SELECT crm_watch('crm_branches', 'branches');

-- Settings speak up only when what the business edits changed: rev moves with every write. One
-- row per workspace, so a row trigger, naming only the key: {"w": workspace, "t": "crm", "k": "settings"}.
CREATE OR REPLACE FUNCTION crm_notify() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM pg_notify('replybek_events', json_build_object('w', r.workspace_id, 't', 'crm', 'k', TG_ARGV[0])::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_notify ON crm_settings;
CREATE TRIGGER crm_notify AFTER UPDATE ON crm_settings FOR EACH ROW
  WHEN (OLD.data IS DISTINCT FROM NEW.data OR OLD.timezone IS DISTINCT FROM NEW.timezone)
  EXECUTE FUNCTION crm_notify('settings');
