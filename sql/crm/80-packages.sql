-- Billing by package: the CRM only, the AI agent only, or both (src/core/billing/packages.js).
-- Runs after schema.sql and the CRM's other files and, like them, can run again and again.
-- Additive only: new columns next to the Polar ones in schema.sql; nothing existing is rewritten.

-- The package the current subscription is for: 'agent', 'crm' or 'both'. Null before packages
-- (every subscription was then the AI agent's) and while there is none.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS billing_package TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_billing_package_known') THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_billing_package_known
      CHECK (billing_package IS NULL OR billing_package IN ('agent', 'crm', 'both'));
  END IF;
END $$;

-- Polar's picture of the current subscription, so a late or repeated event never undoes a newer one:
-- when it started (a subscription started before the running one can't replace it) and when it
-- last changed (an older picture of it is ignored).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_created_at TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_modified_at TIMESTAMPTZ;

-- The products a subscription has already given: each product's free trial is given once.
-- Workspaces that had a subscription before packages had the AI agent's, so its trial is used.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'trial_products') THEN
    ALTER TABLE workspaces ADD COLUMN trial_products TEXT[] NOT NULL DEFAULT '{}';
    UPDATE workspaces SET trial_products = '{agent}' WHERE polar_subscription_id IS NOT NULL;
  END IF;
END $$;

-- Which package a checkout was for. Checkouts from before packages were the AI agent's.
ALTER TABLE billing_checkouts ADD COLUMN IF NOT EXISTS package TEXT NOT NULL DEFAULT 'agent';

-- What the current subscription costs and when its trial ends, as Polar's own subscription says
-- (its `amount` in the currency's smallest unit, `currency`, `recurring_interval`, `trial_end`), kept
-- from every event and sync so the Plan screens can show them without asking Polar. Null when the
-- picture didn't carry them (stored before they were kept). Not `trial_ends_at`: schema.sql drops
-- that name, from an app-side trial that was tried once.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_amount BIGINT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_currency TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_interval TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_trial_end TIMESTAMPTZ;
