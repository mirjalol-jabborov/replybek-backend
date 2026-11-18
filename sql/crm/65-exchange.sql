-- Replybek CRM, Excel import (src/crm/exchange): the previews an import waits on.
-- Runs after 00-core.sql and, like it, can run again and again. Only a new table.
--
-- Importing never writes by itself: a file is first read into a preview (what would be added,
-- changed and skipped), kept here, and only a second call with its token applies exactly that.
-- A preview is the person's own, works once and for 30 minutes.
CREATE TABLE IF NOT EXISTS crm_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,             -- sha256 of the token; the token itself is shown once
  kind TEXT NOT NULL CHECK (kind IN ('customers', 'products')),
  sheet JSONB NOT NULL,                 -- the file's rows as read, by column: { columns, ignored, rows }
  plan JSONB NOT NULL,                  -- what the preview said would happen
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_imports_token ON crm_imports (workspace_id, token_hash);
CREATE INDEX IF NOT EXISTS crm_imports_age ON crm_imports (workspace_id, expires_at);
-- Where a products import's opening stock arrives (the branch it named, or the default one).
ALTER TABLE crm_imports ADD COLUMN IF NOT EXISTS branch_id UUID;
