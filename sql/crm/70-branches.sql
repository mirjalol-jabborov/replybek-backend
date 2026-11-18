-- Replybek CRM, branches: a business with more than one place. Every workspace has had one
-- default branch from the start (00-core.sql) and the row tables carry branch_id; this file adds
-- what lets a business run several. Runs after the module files and, like them, can run again
-- and again. Additive only: no data is changed.

-- ───── The branch itself ─────
ALTER TABLE crm_branches ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
-- Its own working days and hours, {"0": null, "1": ["09:00", "18:00"], …} (0 = Sunday), when they
-- differ from the specialists' own; NULL = it sets none.
ALTER TABLE crm_branches ADD COLUMN IF NOT EXISTS hours JSONB;
-- A closed branch keeps its rows and takes no new work (bookings, orders, stock coming in).
ALTER TABLE crm_branches ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- ───── A team member who works at one branch only ─────
-- They see and change only that branch's rows. It counts while their role is `agent`; admins and
-- the owner are never limited.
CREATE TABLE IF NOT EXISTS crm_member_branches (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships (workspace_id, user_id) ON DELETE CASCADE,
  -- No cascade: a branch someone is limited to can't be deleted under them.
  FOREIGN KEY (workspace_id, branch_id) REFERENCES crm_branches (workspace_id, id)
);
-- Who is limited to a branch, for its row in the snapshot.
CREATE INDEX IF NOT EXISTS crm_member_branches_branch ON crm_member_branches (workspace_id, branch_id);
-- Announced as a change to the branch the person is limited to.
SELECT crm_watch('crm_member_branches', 'branches', 'branch_id');

-- ───── Rows carry the branch of their specialist ─────
-- A booking, a repeat booking and a specialist's time off are where the specialist works: set
-- here when the row is made or given to another specialist, whatever the code sent, so every way
-- of writing them (the team, the public pages, the AI agent, the daily series job) agrees. Moving
-- a specialist to another branch leaves their rows where they are (src/crm/booking/staff.js
-- reports the bookings ahead). Time off for nobody in particular (a closed day) keeps the branch it
-- was given.
CREATE OR REPLACE FUNCTION crm_branch_of_staff() RETURNS trigger AS $$
DECLARE
  b UUID;
BEGIN
  IF NEW.staff_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.staff_id IS NOT DISTINCT FROM OLD.staff_id) THEN
    RETURN NEW;
  END IF;
  SELECT branch_id INTO b FROM crm_staff WHERE workspace_id = NEW.workspace_id AND id = NEW.staff_id;
  -- An unknown specialist is left to the foreign key, which names the problem.
  IF FOUND THEN NEW.branch_id := b; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_branch_of_staff ON crm_appointments;
CREATE TRIGGER crm_branch_of_staff BEFORE INSERT OR UPDATE OF staff_id ON crm_appointments FOR EACH ROW EXECUTE FUNCTION crm_branch_of_staff();
DROP TRIGGER IF EXISTS crm_branch_of_staff ON crm_series;
CREATE TRIGGER crm_branch_of_staff BEFORE INSERT OR UPDATE OF staff_id ON crm_series FOR EACH ROW EXECUTE FUNCTION crm_branch_of_staff();
DROP TRIGGER IF EXISTS crm_branch_of_staff ON crm_time_off;
CREATE TRIGGER crm_branch_of_staff BEFORE INSERT OR UPDATE OF staff_id ON crm_time_off FOR EACH ROW EXECUTE FUNCTION crm_branch_of_staff();

-- ───── Moving goods between branches ─────
-- One move is a pair of ledger lines written in one statement: `transfer` with a minus at the
-- branch the goods leave and the same plus at the branch they reach, each naming the other. So the
-- business's totals never change and each branch's number stays the ledger added up.
ALTER TABLE crm_stock_moves ADD COLUMN IF NOT EXISTS other_branch_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_stock_moves_other_branch') THEN
    ALTER TABLE crm_stock_moves ADD CONSTRAINT crm_stock_moves_other_branch
      FOREIGN KEY (workspace_id, other_branch_id) REFERENCES crm_branches (workspace_id, id);
  END IF;
  -- The ledger's types (20-store.sql) with `transfer` added. Replaced once: the check reads every line.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_stock_moves_type' AND pg_get_constraintdef(oid) LIKE '%transfer%') THEN
    ALTER TABLE crm_stock_moves DROP CONSTRAINT IF EXISTS crm_stock_moves_type;
    ALTER TABLE crm_stock_moves ADD CONSTRAINT crm_stock_moves_type CHECK (
      (type IN ('receipt', 'return', 'reserve') AND qty > 0)
      OR (type IN ('sale', 'writeoff', 'release') AND qty < 0)
      OR (type = 'adjust' AND qty <> 0)
      OR (type = 'transfer' AND qty <> 0 AND other_branch_id IS NOT NULL AND other_branch_id <> branch_id));
  END IF;
END $$;

-- ───── One branch's rows ─────
-- The snapshot narrowed to a branch (?branch=, or a team member limited to one) reads these.
CREATE INDEX IF NOT EXISTS crm_appointments_branch ON crm_appointments (workspace_id, branch_id, start_at);
CREATE INDEX IF NOT EXISTS crm_orders_branch ON crm_orders (workspace_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS crm_stock_moves_branch ON crm_stock_moves (workspace_id, branch_id, seq);
