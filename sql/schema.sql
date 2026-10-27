-- Safe to run repeatedly: `npm run migrate`.
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector, for knowledge search

-- ───── People and workspaces ─────
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Signed-in browsers. Only a hash of the cookie value is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- One business using Replybek. Every row below belongs to exactly one workspace.
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  website TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  plan TEXT NOT NULL DEFAULT 'growth' CHECK (plan IN ('starter', 'growth', 'business')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('owner', 'admin', 'agent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id);

-- ───── Agents ─────
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'friendly' CHECK (tone IN ('professional', 'friendly', 'concise')),
  welcome TEXT NOT NULL DEFAULT 'Hi! How can I help?',
  fallback TEXT NOT NULL DEFAULT 'I don''t have a confident answer to that yet. I can pass your question to the team.',
  handoff BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
  -- Public identifier the widget script uses. Not a secret; access is limited by allowed_origins.
  public_key TEXT UNIQUE NOT NULL DEFAULT ('pk_' || encode(gen_random_bytes(12), 'hex')),
  allowed_origins TEXT[] NOT NULL DEFAULT '{}',
  widget JSONB NOT NULL DEFAULT '{}'::jsonb, -- accent, display_name, branding, photos
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_workspace ON agents (workspace_id);

-- ───── Knowledge ─────
CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('website', 'file', 'qa')),
  name TEXT NOT NULL,
  url TEXT,
  include_linked BOOLEAN NOT NULL DEFAULT false,
  file_path TEXT,          -- uploads: where the original is kept, for retries
  mime TEXT,
  bytes INTEGER,
  qa JSONB,                -- Q&A: [{ q, a }]
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
  error TEXT,              -- plain-language reason when status = error
  pages INTEGER,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_agent ON sources (agent_id);

-- Passages the agent can quote. Embeddings are 1536-dimensional (text-embedding-3-small).
CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source_id);
CREATE INDEX IF NOT EXISTS chunks_agent ON chunks (agent_id);
CREATE INDEX IF NOT EXISTS chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- Questions the agent couldn't answer, grouped by their normalized text.
CREATE TABLE IF NOT EXISTS unanswered (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  normalized TEXT NOT NULL,
  times INTEGER NOT NULL DEFAULT 1,
  last_asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  UNIQUE (agent_id, normalized)
);
-- Questions a teammate removed as not relevant stay hidden, even when asked again.
ALTER TABLE unanswered ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

-- ───── Conversations ─────
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'widget',
  -- ai: the AI replies · needs_human: handed off, AI paused · human: a teammate replies · resolved
  status TEXT NOT NULL DEFAULT 'ai' CHECK (status IN ('ai', 'needs_human', 'human', 'resolved')),
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  visitor JSONB NOT NULL DEFAULT '{}'::jsonb, -- name, email, page, user agent
  visitor_token_hash TEXT NOT NULL,           -- the widget proves it owns the conversation
  subject TEXT,
  summary TEXT[],
  unread BOOLEAN NOT NULL DEFAULT true,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_workspace ON conversations (workspace_id, last_message_at DESC);
-- Set the first time a conversation is handed to a person; analytics counts these as escalated.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS conversations_created ON conversations (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- visitor · ai · human · system (events) · note (internal, never shown to the visitor)
  role TEXT NOT NULL CHECK (role IN ('visitor', 'ai', 'human', 'system', 'note')),
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  kind TEXT,          -- ai only: answer · fallback · handoff
  sources JSONB,      -- ai only: [{ source_id, name, heading, text }]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, created_at);
-- Several messages can be written in one transaction (where now() is the same), so order by a
-- sequence and stamp each row with the real clock.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE messages ALTER COLUMN created_at SET DEFAULT clock_timestamp();
CREATE INDEX IF NOT EXISTS messages_conversation_seq ON messages (conversation_id, seq);

-- ───── Usage, activity, jobs ─────
CREATE TABLE IF NOT EXISTS usage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period TEXT NOT NULL, -- 'YYYY-MM'
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period)
);
-- When the owners were told this month's AI messages ran out (one email a month).
ALTER TABLE usage ADD COLUMN IF NOT EXISTS limit_emailed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_workspace ON activity (workspace_id, created_at DESC);
-- The feed is translated in the dashboard: `key` is an English template, `params` fills it.
ALTER TABLE activity ADD COLUMN IF NOT EXISTS key TEXT;
ALTER TABLE activity ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}';
ALTER TABLE activity ADD COLUMN IF NOT EXISTS detail_key TEXT;
-- Rows written before that: recover the template from the stored English sentence.
UPDATE activity a SET key = m.key, params = m.params
  FROM (
    SELECT x.id,
           CASE WHEN r[1] IS NULL THEN NULL ELSE p.key END AS key,
           jsonb_build_object('actor', x.actor) || CASE WHEN p.param IS NULL OR r[1] IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(p.param, r[1]) END AS params
      FROM (SELECT a.id, u.name AS actor, substr(a.text, length(u.name) + 2) AS rest
              FROM activity a JOIN users u ON u.id = a.actor_id
             WHERE a.key IS NULL AND left(a.text, length(u.name) + 1) = u.name || ' ') x
      CROSS JOIN LATERAL (VALUES
        ('^uploaded “(.*)”$', '{actor} uploaded “{name}”', 'name'),
        ('^added “(.*)”$', '{actor} added “{name}”', 'name'),
        ('^removed “(.*)”$', '{actor} removed “{name}”', 'name'),
        ('^switched to the (\w+) plan$', '{actor} switched to the {plan} plan', 'plan'),
        ('^created (.*)$', '{actor} created {name}', 'name'),
        ('^published (.*)$', '{actor} published {name}', 'name'),
        ('^unpublished (.*)$', '{actor} unpublished {name}', 'name'),
        ('^deleted (.*)$', '{actor} deleted {name}', 'name'),
        ('^(added a Q&A answer)$', '{actor} added a Q&A answer', NULL),
        ('^(took over a conversation)$', '{actor} took over a conversation', NULL)
      ) AS p(re, key, param)
      CROSS JOIN LATERAL (SELECT regexp_match(x.rest, p.re) AS r) rm
     WHERE rm.r IS NOT NULL
  ) m
 WHERE a.id = m.id;
UPDATE activity SET key = text WHERE key IS NULL AND text IN ('A conversation was handed to the team', 'A visitor asked for a teammate');
UPDATE activity SET detail_key = detail WHERE detail_key IS NULL AND detail IN ('Draft', 'Simulated, no payment');

-- A small job queue in Postgres (no Redis). Workers claim rows with FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (run_at) WHERE status = 'queued';

-- ───── Whole-site website sources (sitemap import, page tracking, re-sync) ─────
ALTER TABLE sources ADD COLUMN IF NOT EXISTS mode TEXT;                       -- website: page | site
ALTER TABLE sources ADD COLUMN IF NOT EXISTS include_paths TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE sources ADD COLUMN IF NOT EXISTS discovery TEXT;                  -- sitemap | links | page
ALTER TABLE sources ADD COLUMN IF NOT EXISTS pages_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS pages_over_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS progress JSONB;                  -- { done, total } while processing
-- A re-sync keeps the source answerable (status stays 'ready'); `syncing` just shows it's running.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS syncing BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sync_interval_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS next_sync_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS sources_next_sync ON sources (next_sync_at) WHERE next_sync_at IS NOT NULL;

-- One row per page of a website source, so answers can cite the exact page and failures are visible.
CREATE TABLE IF NOT EXISTS source_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready', 'error')),
  error TEXT,
  content_hash TEXT,
  chars INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, url)
);

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS page_id UUID REFERENCES source_pages(id) ON DELETE CASCADE;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS url TEXT;
-- Keyword search alongside embeddings. 'simple' = no language-specific stemming, so it works the
-- same for Uzbek, Russian and English; prefix queries cover word endings.
-- Apostrophes are removed first, so Uzbek words like qo‘shish or ma'lumot stay one word.
ALTER TABLE chunks DROP COLUMN IF EXISTS tsv;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', translate(coalesce(heading, '') || ' ' || content, '''’‘ʻʼ`´', ''))
) STORED;
CREATE INDEX IF NOT EXISTS chunks_search ON chunks USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS chunks_page ON chunks (page_id);

-- ───── Integrations: an agent acting in a business system for the signed-in customer ─────
-- One integration = one external system (base URL + OAuth client + tools). Tools are configuration:
-- how to call the system and how to read its answer. Secrets are stored encrypted.
CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth JSONB NOT NULL DEFAULT '{}',          -- { authorize_url, token_url, client_id, scope, token_format: form | json }
  headers JSONB NOT NULL DEFAULT '{}',       -- sent with every tool call (templates, e.g. a branch id from context)
  client_secret_enc TEXT,
  context JSONB NOT NULL DEFAULT '[]',       -- values read once after sign-in: [{ name, request, pick }]
  account JSONB NOT NULL DEFAULT '{}',       -- how to name the signed-in account: { request, pick }
  tools JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integrations_agent ON integrations (agent_id);

-- A customer's signed-in account for one conversation. Tokens are encrypted; passwords never reach us.
CREATE TABLE IF NOT EXISTS integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_label TEXT,
  context JSONB NOT NULL DEFAULT '{}',
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (integration_id, conversation_id)
);

-- Changes the AI proposed in the customer's account. They run only after the customer confirms.
CREATE TABLE IF NOT EXISTS pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  args JSONB NOT NULL,
  summary JSONB NOT NULL,                    -- { title, lines: [[label, value]] } shown on the card
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled', 'failed')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

-- An interactive part of an AI message: { type: "connect", integration_id, name } or { type: "confirm", action_id }.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS card JSONB;

-- ───── In-page integrations: the browser runs the request with the user's own session ─────
-- mode 'server' = Replybek calls the system with a stored OAuth token (the default).
-- mode 'in_page' = the widget, running inside the system's own page, runs each request; nothing
-- is stored and no API client is needed. Replybek hands the widget a rendered request and waits.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'server' CHECK (mode IN ('server', 'in_page'));
ALTER TABLE integration_connections ALTER COLUMN access_token_enc DROP NOT NULL;

CREATE TABLE IF NOT EXISTS tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  request JSONB NOT NULL,          -- { method, path, headers, body } for the widget to run
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  response JSONB,                  -- { status, body } the widget got back
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_calls_pending ON tool_calls (conversation_id) WHERE status = 'pending';

-- Generic integration builder: reusable procedures and test status.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS procedures JSONB NOT NULL DEFAULT '[]';
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_test JSONB;
CREATE TABLE IF NOT EXISTS procedure_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  definition JSONB NOT NULL,
  args JSONB NOT NULL,
  results JSONB NOT NULL DEFAULT '{}',
  trace JSONB NOT NULL DEFAULT '[]',
  step_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','waiting','completed','failed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS procedure_run_id UUID REFERENCES procedure_runs(id) ON DELETE CASCADE;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS tool_snapshot JSONB;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS integration_test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  definition JSONB NOT NULL,
  request JSONB NOT NULL,
  scope JSONB NOT NULL,
  result JSONB,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Revisions bind tests and pending approvals to the configuration they reviewed.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS config_revision integer NOT NULL DEFAULT 1;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS integration_revision integer;

-- Admin-curated starter questions; AI generation is an explicit, unsaved draft action.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS suggested_questions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS suggested_questions_i18n JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS suggestion_default_language TEXT NOT NULL DEFAULT 'en';

CREATE TABLE IF NOT EXISTS integration_ai_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  snapshot JSONB NOT NULL,
  batches JSONB NOT NULL,
  results JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'running',
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS integration_ai_drafts_workspace ON integration_ai_drafts(workspace_id, created_at DESC);

-- ───── Billing through Polar ─────
-- Billing went through Whop before Polar; its columns (and any test state they held) go.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'whop_membership_id') THEN
    UPDATE workspaces SET subscription_status = NULL, renews_at = NULL, cancel_at_period_end = false;
    ALTER TABLE workspaces DROP COLUMN whop_membership_id;
    DELETE FROM billing_checkouts;
  END IF;
END $$;
ALTER TABLE workspaces DROP COLUMN IF EXISTS billing_manage_url;
-- The workspace's current Polar subscription. Null until the owner starts one through Polar checkout.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS polar_subscription_id TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_status TEXT;      -- Polar's status: trialing, active, past_due, canceled…
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS renews_at TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;
-- The free trial is Polar's (card required, status "trialing"); an app-side trial column was tried and dropped.
ALTER TABLE workspaces DROP COLUMN IF EXISTS trial_ends_at;
CREATE INDEX IF NOT EXISTS workspaces_polar_subscription ON workspaces (polar_subscription_id) WHERE polar_subscription_id IS NOT NULL;
-- Checkouts the dashboard started, so a payment finds its workspace and the owner who paid.
CREATE TABLE IF NOT EXISTS billing_checkouts (
  id TEXT PRIMARY KEY,                                    -- Polar checkout session id
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Polar retries a delivery with the same webhook-id; each one is applied once.
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───── Teammates and email ─────
-- The dashboard language a person last used; emails to them follow it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT;
-- An invitation by email to join a workspace. One open invitation per address; it works for 7 days.
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_open ON invitations (workspace_id, email) WHERE accepted_at IS NULL;
-- "Forgot password" links: one hour, one use.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
-- When the team was last emailed that this conversation is waiting (at most once an hour).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- ───── Files and photos in conversations ─────
-- One row per file on a message; the bytes live in UPLOAD_DIR/attachments/<id>
-- (src/services/attachments.service.js). Deleting a conversation removes the rows; the files stay
-- on disk until a cleanup job exists.
CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,      -- from the file's own bytes, never from the upload's name
  size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments (message_id);
-- What the AI read from a customer's file (a photo's description, a document's text), so later
-- answers in the conversation still know it. NULL: not read yet, or unreadable.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS ai_text TEXT;

-- The welcome message in other languages ({"uz": …, "ru": …, "en": …}). The widget shows the one for
-- the page's language, and `welcome` when there's none.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS welcome_i18n JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ───── Is the visitor still there? ─────
-- The widget checks in every 30 s while its page is open (and on every message and keystroke
-- signal), so the Inbox can tell a visitor in the chat now from one who left. A visitor who starts
-- a new chat leaves this one: left_at is set, continued_in points at the new conversation and the
-- new one's previous_id back here.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_seen_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS continued_in UUID REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS previous_id UUID REFERENCES conversations(id) ON DELETE SET NULL;

-- ───── Live updates ─────
-- Every change to a conversation, its messages or its tool calls is announced on the channel
-- replybek_events as {"w": workspace, "c": conversation, "t": table, "r": message role}.
-- src/services/events.service.js passes it on to open dashboards and widgets, which then fetch
-- the details the usual way. Updates that change nothing (marking an already-read chat read) stay quiet.
CREATE OR REPLACE FUNCTION replybek_notify() RETURNS trigger AS $$
DECLARE
  r RECORD;
  payload JSON;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF TG_TABLE_NAME = 'conversations' THEN
    payload := json_build_object('w', r.workspace_id, 'c', r.id, 't', TG_TABLE_NAME);
  ELSIF TG_TABLE_NAME = 'messages' THEN
    payload := json_build_object('w', r.workspace_id, 'c', r.conversation_id, 't', TG_TABLE_NAME, 'r', r.role);
  ELSE
    payload := json_build_object('c', r.conversation_id, 't', TG_TABLE_NAME);
  END IF;
  PERFORM pg_notify('replybek_events', payload::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS conversations_notify ON conversations;
CREATE TRIGGER conversations_notify AFTER INSERT OR UPDATE OR DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION replybek_notify();
DROP TRIGGER IF EXISTS messages_notify ON messages;
CREATE TRIGGER messages_notify AFTER INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION replybek_notify();
DROP TRIGGER IF EXISTS tool_calls_notify ON tool_calls;
CREATE TRIGGER tool_calls_notify AFTER INSERT OR UPDATE ON tool_calls FOR EACH ROW EXECUTE FUNCTION replybek_notify();

-- ───── Sign in with Google ─────
-- Google accounts are matched by Google's stable id; a Google-only account has no password.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
-- A person's own photo: a small image as a data: URL (the dashboard crops it to 256 px).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
