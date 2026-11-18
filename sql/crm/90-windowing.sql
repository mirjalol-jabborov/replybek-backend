-- Replybek CRM: what a screen downloads follows what it shows, not how old the business is.
-- Runs after every other CRM file and, like them, can run again and again. Additive only: new
-- indexes and the extensions the customer search needs (no data is changed). The live updates that
-- name the rows are made where every table's are, by crm_watch() (00-core.sql).

-- ───── Indexes the windows and the range routes read ─────
-- The window's finished and cancelled orders: those changed since a day (every step move and edit
-- sets updated_at). The open and reserved ones come by crm_orders_status.
CREATE INDEX IF NOT EXISTS crm_orders_changed ON crm_orders (workspace_id, updated_at);
-- Bookings by step: how many wait for confirmation (the sidebar), from a day on (Today).
CREATE INDEX IF NOT EXISTS crm_appointments_status ON crm_appointments (workspace_id, status, start_at);
-- Orders handed over on a day (Today's numbers).
CREATE INDEX IF NOT EXISTS crm_orders_delivery_day ON crm_orders (workspace_id, (delivery->>'date'));

-- Finding a customer by any part of their name, phone or Telegram handle (GET /customers?q=).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE INDEX IF NOT EXISTS crm_customers_search ON crm_customers
  USING gin (workspace_id, (lower(name || ' ' || phone || ' ' || telegram)) gin_trgm_ops);
