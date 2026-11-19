-- The bridge: where the AI agent works in the CRM for a customer in chat (src/bridge).
-- Runs after the CRM's other files and, like them, can run again and again. Additive only.

-- ───── Confirm cards for the built-in CRM ─────
-- A change the AI agent proposes waits in pending_actions until the customer presses Confirm.
-- Until now every one belonged to an integration. A change in the built-in CRM has none: it says
-- so with source 'crm' and no integration_id. Existing rows are integrations' and stay as they are.
ALTER TABLE pending_actions ALTER COLUMN integration_id DROP NOT NULL;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'integration';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_actions_source') THEN
    ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_source
      CHECK ((source = 'integration' AND integration_id IS NOT NULL) OR (source = 'crm' AND integration_id IS NULL));
  END IF;
END $$;

-- ───── Who the customer in a conversation is to the CRM ─────
-- One row per conversation that used a CRM tool. `customer_id` is empty until the customer is
-- known: then `name` and `phone` hold what they gave, and the customer is added when they confirm
-- their first booking or order. `proof` says how the link was made, which decides what they see:
--   channel  the channel vouches for them: the team saved their       all of the customer's items,
--            Telegram handle on the customer                          while the handle is still theirs
--   new      added from a name and phone typed in this conversation    only what their own chats made
--   phone    a number typed in the chat matched an existing customer   only what their own chats made
-- Anyone can type a number, so only `channel` sees what the team or the pages filed for the customer.
-- "Their own chats": this conversation, and on Telegram every conversation of the same account.
-- `channel_key` ("telegram:<user id>") finds the same customer again in their next conversation,
-- with the same proof as before; `channel` is asked of the handle again every time.
CREATE TABLE IF NOT EXISTS crm_bridge_links (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  customer_id UUID,
  proof TEXT NOT NULL DEFAULT 'none' CHECK (proof IN ('none', 'channel', 'new', 'phone')),
  channel_key TEXT,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, conversation_id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES crm_customers (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS crm_bridge_links_channel ON crm_bridge_links (workspace_id, channel_key) WHERE channel_key IS NOT NULL AND customer_id IS NOT NULL;

-- Bookings and orders a conversation made, so a customer not vouched for by the channel sees and
-- changes those and nothing else of the customer record.
CREATE TABLE IF NOT EXISTS crm_bridge_items (
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  item TEXT NOT NULL CHECK (item IN ('appointment', 'order')),
  item_id UUID NOT NULL,
  PRIMARY KEY (workspace_id, conversation_id, item, item_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES crm_bridge_links (workspace_id, conversation_id) ON DELETE CASCADE
);

-- A newer card for the same change retires the older one still waiting in the conversation.
CREATE INDEX IF NOT EXISTS pending_actions_crm_waiting ON pending_actions (conversation_id) WHERE source = 'crm' AND status = 'pending';

-- Whether an agent's website chat is in use (CRM settings, the AI agent section: its channels).
CREATE INDEX IF NOT EXISTS conversations_agent_channel ON conversations (agent_id, channel);

-- ───── The cart in a chat ─────
-- What the customer put aside in this conversation before ordering: a card's "Add to cart" button
-- or the AI agent (crm_add_to_cart). Nothing is held or ordered by it; crm_place_order without
-- lines orders what is here, and the order takes its things out. One row per variant, at most 10
-- of it (the Store's cap on one customer order). Products are the CRM's, so a row whose product
-- went off sale or was deleted simply reads as unavailable.
CREATE TABLE IF NOT EXISTS crm_bridge_cart (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID NOT NULL,
  qty INT NOT NULL CHECK (qty BETWEEN 1 AND 10),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, conversation_id, variant_id)
);
