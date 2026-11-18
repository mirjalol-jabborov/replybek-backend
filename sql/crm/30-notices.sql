-- Replybek CRM: messages to customers (booked, moved, cancelled, reminders, order steps).
-- Runs after 00-core.sql; can run again and again (IF NOT EXISTS, CREATE OR REPLACE). Additive only.

-- ───── Messages ─────
-- One row per message, from the moment it is queued. The text is final when it is queued (a
-- reminder is written again when its booking moves). `address` is where the channel sends it
-- (for Telegram "<agent channel id>:<chat id>"); it never leaves the server.
CREATE TABLE IF NOT EXISTS crm_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL,
  -- booked · moved · cancelled · reminder · orderStep · orderCancelled
  kind TEXT NOT NULL,
  -- The item it is about, by its snapshot key: "appointments" or "orders". No foreign key: the
  -- record stays when the item is deleted.
  item_key TEXT NOT NULL,
  item_id UUID NOT NULL,
  -- The specialist of a booking, so a team member who sees only their own bookings sees only their messages.
  staff_id UUID,
  channel TEXT NOT NULL,                 -- telegram · sms · none
  address TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  language TEXT NOT NULL,
  -- queued → sending (claimed by a worker) → sent | failed; skipped when it should not go (a reason says why)
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  reason TEXT,                           -- a code: no_channel, superseded, item_gone, switched_off, too_late, blocked, ...
  send_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A reminder: when its booking starts, and the moment it was written for ("2026-11-19T09:30").
  item_at TIMESTAMPTZ,
  item_start TEXT,
  sent_at TIMESTAMPTZ,
  tries INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  -- The clock, not the transaction's start: messages queued by one write keep the order they were made in.
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES crm_customers (workspace_id, id) ON DELETE CASCADE
);
-- The list, newest first; by customer; by item (also how a write finds the messages of its items).
CREATE INDEX IF NOT EXISTS crm_notices_workspace ON crm_notices (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crm_notices_customer ON crm_notices (workspace_id, customer_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crm_notices_item ON crm_notices (workspace_id, item_id, created_at DESC, id DESC);
-- The sender works across workspaces, like the jobs queue: what is due, and what a crashed worker left.
CREATE INDEX IF NOT EXISTS crm_notices_due ON crm_notices (send_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS crm_notices_sending ON crm_notices (claimed_at) WHERE status = 'sending';
-- A booking has at most one reminder waiting: a move re-times it in place.
CREATE UNIQUE INDEX IF NOT EXISTS crm_notices_one_reminder ON crm_notices (workspace_id, item_id) WHERE kind = 'reminder' AND status = 'queued';

SELECT crm_watch('crm_notices', 'notices');

-- ───── What the last write showed of each item ─────
-- Messages are decided by comparing an item with how it was before (a new step, a new time).
-- Writes report their rows after they commit, possibly out of order, so each row keeps the `rev`
-- of the write it came from and an older report never overwrites a newer one.
CREATE TABLE IF NOT EXISTS crm_notice_items (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_id UUID NOT NULL,
  rev BIGINT NOT NULL,
  state JSONB,                           -- { status, kind, start?, staffId? }; null once the item is deleted
  PRIMARY KEY (workspace_id, item_key, item_id)
);

-- ───── Added later ─────
-- The item as a message was written for it ({ status, kind, start?, staffId?, customerId? }):
-- the sender checks it against crm_notice_items before the message goes, so a message about a
-- visit or an order that changed since is skipped (item_changed), never sent wrong. Null on rows
-- queued before it existed: those are not checked (reminders still are, by item_start).
ALTER TABLE crm_notices ADD COLUMN IF NOT EXISTS item_state JSONB;
