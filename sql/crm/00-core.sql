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

-- ───── Live updates ─────
-- Every CRM table says when it changed: {"w": workspace, "t": "crm", "k": snapshot key} on the
-- same channel the inbox uses (replybek_notify in schema.sql). src/services/events.service.js
-- passes it on to open CRM screens, which then fetch snapshot?only=<key>. An UPDATE that changes
-- nothing stays quiet. The same payload sent twice in one transaction arrives once.
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

-- SELECT crm_watch('crm_orders', 'orders'): from now on the table announces its changes under
-- that snapshot key. The table needs a workspace_id column.
CREATE OR REPLACE FUNCTION crm_watch(tbl TEXT, key TEXT) RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS crm_notify ON %I', tbl);
  EXECUTE format('CREATE TRIGGER crm_notify AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_notify(%L)', tbl, key);
END;
$$ LANGUAGE plpgsql;

SELECT crm_watch('crm_customers', 'customers');
SELECT crm_watch('crm_branches', 'branches');
-- Settings speak up only when what the business edits changed: rev moves with every write.
DROP TRIGGER IF EXISTS crm_notify ON crm_settings;
CREATE TRIGGER crm_notify AFTER UPDATE ON crm_settings FOR EACH ROW
  WHEN (OLD.data IS DISTINCT FROM NEW.data OR OLD.timezone IS DISTINCT FROM NEW.timezone)
  EXECUTE FUNCTION crm_notify('settings');
