-- Replybek CRM, reports (src/crm/reports): indexes for the questions "what happened between two days".
-- Runs after 20-store.sql and, like it, can run again and again. Only indexes: no data changes.
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
