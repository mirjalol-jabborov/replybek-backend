-- Replybek CRM, reports (src/crm/reports): indexes for the questions "what happened between two days",
-- and the day a specialist was switched off (their working time ends there).
-- Runs after 20-store.sql and, like it, can run again and again. Additive: no stored data is changed.
--
-- Without them the income, products, stock and customer reports read every ledger line and every
-- payment the workspace ever had (a sequential scan of the workspace's history), whatever span is
-- asked. With them they read only the span. Shown with EXPLAIN ANALYZE on 60,000 orders over two
-- years, asking for one month: ledger 57,469 rows read and dropped -> an index range of 2,542;
-- payments the same (see AS-BUILT-reports.md).

-- The ledger by time: sales (when an order was handed over), returns, and any goods movement.
CREATE INDEX IF NOT EXISTS crm_stock_moves_at ON crm_stock_moves (workspace_id, at);
-- Money by the time it came in or went back.
CREATE INDEX IF NOT EXISTS crm_payments_at ON crm_payments (workspace_id, at);

-- ───── When a specialist was switched off ─────
-- A specialist's working time counts from the day they were added (created_at) to the day they
-- were switched off, so a past span keeps the hours they really had. Set here for every way of
-- writing a specialist; switched on again, it is cleared (the days between are not kept). NULL
-- for one switched off before this was kept: such a specialist counts no working time.
ALTER TABLE crm_staff ADD COLUMN IF NOT EXISTS inactive_since TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION crm_staff_inactive_since() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.active IS DISTINCT FROM OLD.active THEN
    NEW.inactive_since := CASE WHEN NEW.active THEN NULL ELSE now() END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_staff_inactive_since ON crm_staff;
CREATE TRIGGER crm_staff_inactive_since BEFORE INSERT OR UPDATE OF active ON crm_staff FOR EACH ROW EXECUTE FUNCTION crm_staff_inactive_since();
