-- Replybek CRM, public pages: a business's own booking page and shop page (src/crm/public).
-- Runs after the other CRM files and, like them, can run again and again. Additive only.

-- ───── The page's address ─────
-- settings.publicPage.slug is the page's name in the address (/public/crm/<slug>). One workspace
-- per address: this index is the guarantee, and it is also how a request finds its workspace.
CREATE UNIQUE INDEX IF NOT EXISTS crm_settings_public_slug ON crm_settings ((data->'settings'->'publicPage'->>'slug'))
  WHERE (data->'settings'->'publicPage'->>'slug') <> '';

-- ───── What customers made on a page ─────
-- One row per booking or order made from a public page: its short reference and the hash of the
-- secret token that lets the customer look at it (never the token itself). The booking or the
-- order itself lives in its own module's table, marked as made by the customer (customer_made):
-- the daily share and the goods a waiting order holds are counted there, for the pages and the
-- AI agent alike.
CREATE TABLE IF NOT EXISTS crm_public_requests (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,                     -- "K7M2QX9P": what the customer quotes
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'order')),
  appointment_id UUID,
  order_id UUID,
  token_hash BYTEA NOT NULL,             -- sha256 of the token
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, ref),
  CHECK ((kind = 'booking') = (appointment_id IS NOT NULL) AND (kind = 'order') = (order_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, appointment_id) REFERENCES crm_appointments (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, order_id) REFERENCES crm_orders (workspace_id, id) ON DELETE CASCADE
);
-- A table made by the first version of this file also kept the phone and the day for a daily cap
-- of its own; nothing writes them any more.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'crm_public_requests' AND column_name = 'phone' AND is_nullable = 'NO') THEN
    ALTER TABLE crm_public_requests ALTER COLUMN phone DROP NOT NULL, ALTER COLUMN day DROP NOT NULL;
  END IF;
END $$;
-- The foreign keys' own lookups when a booking or an order is deleted.
CREATE INDEX IF NOT EXISTS crm_public_requests_appointment ON crm_public_requests (workspace_id, appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_public_requests_order ON crm_public_requests (workspace_id, order_id) WHERE order_id IS NOT NULL;
