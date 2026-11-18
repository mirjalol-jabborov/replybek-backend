-- Replybek CRM, the Store module: products, the stock ledger, orders and their payments.
-- Runs after 00-core.sql and, like it, can run again and again.
-- Money is whole soʻm (BIGINT). Quantities are whole units.

-- ───── Products ─────
CREATE TABLE IF NOT EXISTS crm_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',   -- an id from the workspace's productCategories, or empty
  unit TEXT NOT NULL DEFAULT '',       -- an id from the workspace's units
  image TEXT NOT NULL DEFAULT '',      -- a path: a static one ("/products/x.jpg") or an uploaded image's
  on_sale BOOLEAN NOT NULL DEFAULT true,
  -- What a buyer chooses between: [{ id, name, values: ["S", "M"] }]. Empty for a plain product.
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS crm_products_workspace ON crm_products (workspace_id, created_at);
-- "Does a product still show this picture?" (src/crm/store/images.js).
CREATE INDEX IF NOT EXISTS crm_products_image ON crm_products (workspace_id, image) WHERE image <> '';

-- Pictures uploaded for products: a row is the stored file's record. A product can show an uploaded
-- picture only while its row is there, and one that no product shows is removed a day after the
-- upload (or as soon as the last product that showed it lets it go).
CREATE TABLE IF NOT EXISTS crm_product_images (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                  -- "<uuid>.png", the file's name in storage
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS crm_product_images_age ON crm_product_images (workspace_id, created_at);
-- Pictures products showed before these rows existed get theirs.
INSERT INTO crm_product_images (workspace_id, name)
SELECT DISTINCT workspace_id, substring(image FROM '[^/]+$') FROM crm_products
 WHERE image LIKE '/w/' || workspace_id || '/crm/products/images/%'
ON CONFLICT DO NOTHING;

-- Price, SKU and stock live on the variant. A product without options has one variant nobody sees.
CREATE TABLE IF NOT EXISTS crm_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  option_values JSONB NOT NULL DEFAULT '{}'::jsonb, -- { [optionId]: "M" }
  sku TEXT NOT NULL DEFAULT '',
  price BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),
  cost BIGINT NOT NULL DEFAULT 0 CHECK (cost >= 0),
  low_at INTEGER NOT NULL DEFAULT 0 CHECK (low_at >= 0), -- "running low" at this many available
  position INTEGER NOT NULL DEFAULT 0,
  -- A variant that was sold once can't be deleted (orders and the ledger point at it): it is put away.
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, product_id) REFERENCES crm_products (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS crm_variants_of_product ON crm_variants (workspace_id, product_id, position);
-- Each thing on sale has its own SKU, whatever the letter case. Variants without one are fine.
CREATE UNIQUE INDEX IF NOT EXISTS crm_variants_sku ON crm_variants (workspace_id, lower(sku)) WHERE sku <> '' AND NOT archived;

-- Every product has at least one variant in use. Checked when the transaction ends, so a product
-- and its first variant can be written one after the other.
CREATE OR REPLACE FUNCTION crm_product_keeps_variant() RETURNS trigger AS $$
DECLARE
  pid UUID;
  wid UUID;
BEGIN
  IF TG_TABLE_NAME = 'crm_products' THEN pid := NEW.id; wid := NEW.workspace_id;
  ELSIF TG_OP = 'DELETE' THEN pid := OLD.product_id; wid := OLD.workspace_id;
  ELSE pid := NEW.product_id; wid := NEW.workspace_id; END IF;
  -- workspace_id first, so the lookup uses crm_variants_of_product.
  IF EXISTS (SELECT 1 FROM crm_products WHERE id = pid)
     AND NOT EXISTS (SELECT 1 FROM crm_variants WHERE workspace_id = wid AND product_id = pid AND NOT archived) THEN
    RAISE EXCEPTION 'A product needs at least one variant.' USING ERRCODE = '23514', CONSTRAINT = 'crm_product_keeps_variant';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_product_keeps_variant ON crm_products;
CREATE CONSTRAINT TRIGGER crm_product_keeps_variant AFTER INSERT ON crm_products
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_product_keeps_variant();
DROP TRIGGER IF EXISTS crm_product_keeps_variant ON crm_variants;
CREATE CONSTRAINT TRIGGER crm_product_keeps_variant AFTER DELETE OR UPDATE OF archived, product_id ON crm_variants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_product_keeps_variant();

-- ───── Orders ─────
CREATE TABLE IF NOT EXISTS crm_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  number BIGINT NOT NULL,               -- from crm_settings.order_seq, one row of numbers per workspace
  customer_id UUID NOT NULL,
  status TEXT NOT NULL,                 -- an id from the workspace's orderStages
  delivery JSONB NOT NULL DEFAULT '{}'::jsonb, -- { type, address, date, slot, time, fee }
  payment TEXT NOT NULL DEFAULT '',     -- an id from the workspace's paymentMethods: how it will be paid
  discount BIGINT NOT NULL DEFAULT 0 CHECK (discount >= 0), -- off the whole order, on top of the lines' own
  source TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  history JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ at, text, by, … }], oldest first
  returned BOOLEAN NOT NULL DEFAULT false,    -- a finished order whose goods came back
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, number),
  FOREIGN KEY (workspace_id, branch_id) REFERENCES crm_branches (workspace_id, id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES crm_customers (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS crm_orders_workspace ON crm_orders (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS crm_orders_of_customer ON crm_orders (workspace_id, customer_id);
CREATE INDEX IF NOT EXISTS crm_orders_status ON crm_orders (workspace_id, status);

CREATE TABLE IF NOT EXISTS crm_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  variant_id UUID NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  price BIGINT NOT NULL CHECK (price >= 0),        -- for one, as it was when the line was added
  discount BIGINT NOT NULL DEFAULT 0 CHECK (discount >= 0), -- off this line as a whole
  position INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT crm_order_lines_discount CHECK (discount <= qty * price),
  FOREIGN KEY (workspace_id, order_id) REFERENCES crm_orders (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES crm_variants (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS crm_order_lines_of_order ON crm_order_lines (workspace_id, order_id, position);
CREATE INDEX IF NOT EXISTS crm_order_lines_of_variant ON crm_order_lines (workspace_id, variant_id);

-- Money that came in for an order. A refund is a payment with a minus.
CREATE TABLE IF NOT EXISTS crm_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq BIGSERIAL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  amount BIGINT NOT NULL CHECK (amount <> 0),
  method TEXT NOT NULL DEFAULT '',      -- an id from the workspace's paymentMethods
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  by_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (workspace_id, order_id) REFERENCES crm_orders (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS crm_payments_of_order ON crm_payments (workspace_id, order_id, seq);

-- ───── Stock ─────
-- The ledger is the truth: every change of stock is one line here, and lines are never changed or
-- removed. receipt, sale, writeoff, return and adjust move what is on hand; reserve and release
-- move what accepted orders hold.
CREATE TABLE IF NOT EXISTS crm_stock_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq BIGSERIAL,                         -- the order things happened in
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  type TEXT NOT NULL,
  qty BIGINT NOT NULL,                   -- signed: + comes in (or is held), - goes out (or is let go); a count can move billions
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  by_name TEXT NOT NULL DEFAULT '',
  note JSONB NOT NULL DEFAULT '""'::jsonb, -- what someone typed, or {en, ru, uz}
  reason TEXT NOT NULL DEFAULT '',       -- why goods were written off (an id the app knows)
  order_id UUID,
  CONSTRAINT crm_stock_moves_type CHECK (
    (type IN ('receipt', 'return', 'reserve') AND qty > 0)
    OR (type IN ('sale', 'writeoff', 'release') AND qty < 0)
    OR (type = 'adjust' AND qty <> 0)),
  FOREIGN KEY (workspace_id, variant_id) REFERENCES crm_variants (workspace_id, id),
  FOREIGN KEY (workspace_id, branch_id) REFERENCES crm_branches (workspace_id, id),
  FOREIGN KEY (workspace_id, order_id) REFERENCES crm_orders (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS crm_stock_moves_workspace ON crm_stock_moves (workspace_id, seq DESC);
CREATE INDEX IF NOT EXISTS crm_stock_moves_of_variant ON crm_stock_moves (workspace_id, variant_id);
CREATE INDEX IF NOT EXISTS crm_stock_moves_of_order ON crm_stock_moves (workspace_id, order_id) WHERE order_id IS NOT NULL;

-- What is on the shelf and what is held, per variant and branch: the ledger added up. Nobody
-- writes here but the trigger below, so the numbers can't drift from the ledger, and the checks
-- make the database itself refuse to sell or hold what isn't there.
CREATE TABLE IF NOT EXISTS crm_stock (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  -- 64-bit: one receive may bring 200 x 1,000,000 units, so 32 bits would run out after eleven.
  on_hand BIGINT NOT NULL DEFAULT 0,
  reserved BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (variant_id, branch_id),
  CONSTRAINT crm_stock_on_hand CHECK (on_hand >= 0),
  CONSTRAINT crm_stock_reserved CHECK (reserved >= 0),
  CONSTRAINT crm_stock_reserved_on_hand CHECK (reserved <= on_hand),
  FOREIGN KEY (workspace_id, variant_id) REFERENCES crm_variants (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, branch_id) REFERENCES crm_branches (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS crm_stock_workspace ON crm_stock (workspace_id);
-- Databases made before the numbers were 64-bit. Changing a column's type rewrites the table, it
-- updates no row, so the ledger's own guard (crm_stock_moves_keep) does not fire.
DO $$
DECLARE
  typ TEXT;
BEGIN
  SELECT data_type INTO typ FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'crm_stock' AND column_name = 'on_hand';
  IF typ = 'integer' THEN ALTER TABLE crm_stock ALTER COLUMN on_hand TYPE BIGINT, ALTER COLUMN reserved TYPE BIGINT; END IF;
  SELECT data_type INTO typ FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'crm_stock_moves' AND column_name = 'qty';
  IF typ = 'integer' THEN ALTER TABLE crm_stock_moves ALTER COLUMN qty TYPE BIGINT; END IF;
END;
$$;

-- The row is changed first and made only when there is none yet: an INSERT ... ON CONFLICT would
-- test the checks against the bare change (a sale's minus) before it ever met the row.
-- Stock that grows may not take its product's stock (all variants, all branches) past 2^53 - 1:
-- the app is sent these numbers as JSON, which keeps no larger whole number exactly, so a count
-- made from what it shows would write a wrong difference. Refused as "out of range" (22003), like
-- a number past BIGINT. Only new lines are checked; rows already kept stay as they are.
CREATE OR REPLACE FUNCTION crm_stock_apply() RETURNS trigger AS $$
DECLARE
  held BOOLEAN := NEW.type IN ('reserve', 'release');
  d_on_hand BIGINT := CASE WHEN held THEN 0 ELSE NEW.qty END;
  d_reserved BIGINT := CASE WHEN held THEN NEW.qty ELSE 0 END;
BEGIN
  UPDATE crm_stock SET on_hand = on_hand + d_on_hand, reserved = reserved + d_reserved
   WHERE variant_id = NEW.variant_id AND branch_id = NEW.branch_id;
  IF NOT FOUND THEN
    INSERT INTO crm_stock (workspace_id, variant_id, branch_id, on_hand, reserved)
    VALUES (NEW.workspace_id, NEW.variant_id, NEW.branch_id, d_on_hand, d_reserved);
  END IF;
  IF d_on_hand > 0 AND (
    SELECT sum(s.on_hand) FROM crm_variants v JOIN crm_stock s ON s.variant_id = v.id
     WHERE v.workspace_id = NEW.workspace_id
       AND v.product_id = (SELECT product_id FROM crm_variants WHERE workspace_id = NEW.workspace_id AND id = NEW.variant_id)
  ) > 9007199254740991 THEN
    RAISE EXCEPTION 'More stock than can be shown exactly.' USING ERRCODE = '22003';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_stock_apply ON crm_stock_moves;
CREATE TRIGGER crm_stock_apply AFTER INSERT ON crm_stock_moves FOR EACH ROW EXECUTE FUNCTION crm_stock_apply();

-- A ledger line stays as written. Lines go only together with their whole workspace.
CREATE OR REPLACE FUNCTION crm_stock_moves_keep() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RAISE EXCEPTION 'Stock ledger lines are never removed.' USING ERRCODE = '23514', CONSTRAINT = 'crm_stock_moves_keep';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.workspace_id, NEW.variant_id, NEW.branch_id, NEW.type, NEW.qty) IS DISTINCT FROM (OLD.workspace_id, OLD.variant_id, OLD.branch_id, OLD.type, OLD.qty) THEN
    RAISE EXCEPTION 'Stock ledger lines are never changed.' USING ERRCODE = '23514', CONSTRAINT = 'crm_stock_moves_keep';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_stock_moves_keep ON crm_stock_moves;
CREATE TRIGGER crm_stock_moves_keep BEFORE UPDATE OR DELETE ON crm_stock_moves FOR EACH ROW EXECUTE FUNCTION crm_stock_moves_keep();

-- ───── Orders customers made themselves ─────
-- A public page or the AI agent made it. Such an order counts toward the customer's daily share
-- (shared/customer.js PER_PHONE_PER_DAY), and while it waits in an open step it holds what it asks
-- for from other customers for HOLD_MINUTES (shared/store.js; store/for-customers.js).
ALTER TABLE crm_orders ADD COLUMN IF NOT EXISTS customer_made BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS crm_orders_customer_made ON crm_orders (workspace_id, created_at) WHERE customer_made;

-- ───── Live updates ─────
-- Stock numbers are part of a product as the app reads it, so they announce "products", naming
-- the product (a stock sum through its variant); a line or a payment names its order.
SELECT crm_watch('crm_products', 'products');
SELECT crm_watch('crm_variants', 'products', 'product_id');
SELECT crm_watch('crm_stock', 'products', 'variant_id', 'variant');
SELECT crm_watch('crm_stock_moves', 'movements');
SELECT crm_watch('crm_orders', 'orders');
SELECT crm_watch('crm_order_lines', 'orders', 'order_id');
SELECT crm_watch('crm_payments', 'orders', 'order_id');
