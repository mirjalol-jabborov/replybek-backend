# Replybek backend

Express + PostgreSQL (pgvector) API for Replybek: workspaces and accounts, agents, knowledge
(websites, files, Q&A), AI answers with sources, the support inbox, and the public API the
chat widget calls from customers' websites. Plain JavaScript (ES modules), the same stack as Habitnex.

## Run locally

Run every command from this folder.

1. `npm install`
2. `npm run db:up` starts Postgres 16 + pgvector on `localhost:54329` and MinIO (uploaded files) on
   `localhost:59000`, console on `localhost:59001` (replybek / replybek-dev). Dev only.
3. Put your OpenAI key in `.env` (see `.env.example`). The database needs no settings locally.
4. `npm run migrate` creates or updates the tables (safe to run again).
5. `npm run dev` serves the API on http://localhost:3100. Knowledge processing runs in the same process.

`npm run smoke` checks the OpenAI key with three tiny calls and never prints it.

Uploaded files (knowledge files, chat attachments) go through `src/lib/storage.js`: to the S3 bucket
named by `S3_BUCKET` (MinIO locally; any S3-compatible store in production, created on the first
upload), or to `UPLOAD_DIR` on disk when `S3_BUCKET` is empty. Tests and e2e always use the disk.

## Tests

`npm test` migrates the separate `replybek_test` database and runs everything against a fake
OpenAI (no key, no cost, same result every run). Covered: sign-up and sessions, workspace
isolation, Q&A/website/file knowledge (including robots.txt, private-address blocking and a
real PDF), retries, Playground answers, fallback and unanswered questions, moderation, the
widget → handoff → takeover → reply flow, internal notes never reaching visitors, and usage counting.

## Generic integration builder

The dashboard configures any compatible business API; no vendor is selected in the runtime.
Connections support customer OAuth, an encrypted business API key, a public API, or the
customer's existing browser session. A business API key grants the same account access to
every conversation: use customer OAuth or an in-page connection for private customer accounts.

- Import a single JSON cURL request, an OpenAPI 3.x JSON/YAML document, or a Replybek
  configuration package. Imports produce editable drafts and never execute commands.
  OpenAPI imports support local references, scalar parameters and JSON bodies, with up to
  30 operations. External references, recursive/composed schemas, multiple operation servers
  and non-JSON bodies require simplification before importing.
- Bind action inputs to customer values, account context, fixed values or earlier procedure
  results. Server-resolved bindings override model arguments and are removed from the model's
  input schema. `{{args.id | url}}` safely encodes a path/query parameter. Response mappings
  select which result fields reach the agent.
- Preview a request without sending it, simulate a response (including HTTP failures), or
  explicitly run a live **GET read** test. POST reads and all write actions use simulations.
  OAuth tests accept an access token for the test without persisting it. Browser tests generate a
  script for the administrator's signed-in system tab, with an origin-bound, one-use token
  expiring after ten minutes. `PUBLIC_API_URL` must be reachable and allowed by that tab's
  browser/CSP policy. Test payloads should use sample data.
- Procedures run up to 12 ordered action/check steps within one integration. Map procedure
  inputs with `{{args.name}}` and earlier mapped results with `{{steps.step_name.field}}`.
  Each write pauses for its own customer confirmation; cancellation, failed checks and
  action failures stop the procedure. Simulation accepts raw mock responses keyed by step ID.
  There is no rollback of already completed actions or automatic replay after a process crash.
- Exports omit stored credentials, customer sessions and test results. Literal custom headers
  and fixed input values are cleared (their bindings stay fixed); reconnect and review custom request literals before sharing
  or enabling an imported package.

Configuration revisions invalidate stale tests and pending confirmations. Updating connection
settings also clears cached customer connections. Confirmations are claimed atomically, so a
double click cannot submit the same pending write twice. A timeout may still leave an uncertain
external outcome: verify it in the business system before starting another action.

Run `npm run migrate` before starting this version. The migration adds procedure runs,
integration test runs and revision tracking without clearing existing data. `npm test` covers
imports, binding enforcement, tenant isolation, test safety, procedure continuation/cancellation
and confirmation replay. The sibling `e2e` journey covers the dashboard setup and mobile editor.

## How it fits together

- **Knowledge.** Adding a source stores a row and queues an `ingest_source` job (a Postgres
  job queue; no Redis). The worker fetches or reads it, splits it into ~900-character passages,
  embeds them with `text-embedding-3-small` and stores them in `chunks` (pgvector, HNSW index).
- **Websites.** "Check site" reads robots.txt and the sitemap (including indexes and gzipped
  sitemaps) and shows sections with page counts. A site import fetches the chosen sections three
  pages at a time, retries slow pages once, and falls back to following links when there's no
  sitemap. It removes text repeated on most pages (menus and footers that site builders like
  Tilda don't mark as navigation) and stores one `source_pages` row per page. Imports are capped
  by plan (`pages`: 50 / 500 / 5,000). Re-syncs run on a schedule (daily, weekly or monthly; weekly
  by default) or by hand. They re-embed only pages whose content changed, drop pages that left the
  site, and keep the current pages answerable meanwhile.
- **Search.** Hybrid: pgvector cosine similarity plus Postgres keyword search (`simple` config,
  apostrophes removed, prefix matching for Uzbek and Russian word endings), merged with reciprocal
  rank fusion. If the best match is weak or the message is a follow-up, the model writes up to two
  better queries (one in the other language), and their results are merged in.
- **Answers.** Each question is checked by moderation, then searched as above. Answers cite each page once with
  its link and reply in the customer's language. With no good match the business's fallback is used
  (translated) and the question is logged as unanswered.
  Otherwise the chat model answers from the passages only, as JSON with cited passages and a
  handoff decision. It never promises refunds or exceptions.
- **Inbox.** Conversation status is `ai`, `needs_human` (handed off, AI paused), `human`
  (a teammate replies) or `resolved`. Internal notes are `note` messages and are never
  returned by the widget API.
- **Widget API** (`/widget/:public_key/...`). It works only for published agents and checks each agent's allowed
  websites. No cookies: a visitor proves a conversation is theirs with the token returned at start.

## API

Dashboard routes use the `nx_session` cookie (httpOnly, SameSite=Lax) and must send JSON.
Everything under `/w/:workspace_id` is limited to members of that workspace.

| Method | Path | What |
| --- | --- | --- |
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Account and session |
| GET | `/auth/me` | User and their workspaces |
| GET / PATCH | `/w/:wid` | Workspace with plan limits and usage |
| GET | `/w/:wid/members`, `/w/:wid/activity` | Team, recent activity |
| GET / POST | `/w/:wid/agents` | List / create |
| GET / PATCH / DELETE | `/w/:wid/agents/:aid` | Agent settings, widget look, allowed websites |
| POST | `/w/:wid/agents/:aid/publish`, `/unpublish` | Make reachable from the widget |
| POST | `/w/:wid/agents/:aid/test` | Playground answer with unsaved `draft` settings |
| GET | `/w/:wid/agents/:aid/sources` | Knowledge sources |
| POST | `/w/:wid/agents/:aid/sources/website/preview` | Sitemap sections and page counts for a URL |
| POST | `/w/:wid/agents/:aid/sources/website`, `/qa`, `/file` | Add a source. Website: `mode` page or site, `include_paths`, `sync_interval_days`. File: multipart `file`, 20 MB |
| GET | `/w/:wid/sources/:sid/pages?status=&q=` | Pages of a website source, failed first |
| POST | `/w/:wid/sources/:sid/resync` | Re-fetch a website now (stays answerable) |
| PATCH | `/w/:wid/sources/:sid` | `sync_interval_days`: 0, 1, 7 or 30 |
| GET / DELETE | `/w/:wid/sources/:sid` | Detail with sample passages / remove |
| POST | `/w/:wid/sources/:sid/retry` | Process again |
| GET | `/w/:wid/unanswered` | Questions the agent couldn't answer |
| GET | `/w/:wid/conversations?view=all\|needs_human\|ai\|mine\|resolved&agent=&q=` | Inbox list |
| GET | `/w/:wid/conversations/:cid` | Transcript (marks read) |
| POST | `/w/:wid/conversations/:cid/takeover`, `/hand-back`, `/reply`, `/note`, `/assign`, `/resolve`, `/reopen`, `/unread` | Inbox actions. `/reply` and `/note` also take multipart `text` + `file` |
| GET | `/w/:wid/files/:fid` | A file from a conversation (members only) |
| GET | `/w/:wid/stream` | Live updates (Server-Sent Events): which conversations changed |
| GET / POST | `/w/:wid/invites` | Admins: open invitations / invite `{ email, role: admin\|agent }` (returns the link too) |
| POST / DELETE | `/w/:wid/invites/:iid/resend`, `/w/:wid/invites/:iid` | Admins: new link and 7 more days / cancel |
| PATCH / DELETE | `/w/:wid/members/:uid` | Admins: change role / remove (not the owner, not yourself) |
| GET | `/invites/:token` | Public: what an invitation is for |
| POST | `/invites/:token/accept`, `/invites/:token/join` | Signed in with the invited address / new account `{ name, password }` |
| POST | `/auth/password/forgot`, `/auth/password/reset` | Email a one-hour reset link / set the new password (signs out other sessions) |
| GET | `/widget/:key/config` | Public: name, welcome, accent |
| POST | `/widget/:key/conversations` | Public: start a chat, returns `visitor_token` |
| POST / GET | `/widget/:key/conversations/:cid/messages` | Public: send (JSON `text`, or multipart `text` + `file`) / poll (`X-Visitor-Token`) |
| GET | `/widget/:key/conversations/:cid/files/:fid` | Public: a file on a visible message (token header, never a bare URL) |
| GET | `/widget/:key/conversations/:cid/stream` | Public: live updates for this conversation (token header) |
| POST | `/widget/:key/conversations/:cid/handoff` | Public: ask for a person |
| GET / POST | `/w/:wid/integrations` | Admins: list / add an integration (`/integrations/setup` returns the redirect URI) |
| PATCH / DELETE | `/w/:wid/integrations/:iid` | Admins: change (secret kept unless sent) / remove |
| POST | `/widget/:key/conversations/:cid/integrations/:iid/connect` | Public: the sign-in URL for this conversation |
| POST | `/widget/:key/conversations/:cid/actions/:aid/confirm`, `/cancel` | Public: the customer's answer to a proposed change |
| POST | `/widget/:key/conversations/:cid/tool-calls/:tid` | Public: the browser delivers an in-page request's result |
| GET | `/widget.js`, `/replybek-widget.js` | The built chat widget script |
| GET | `/oauth/callback` | The page an integration's sign-in returns to |

## Integrations

An agent can act in a business system (an ERP, a CRM, a shop) for the customer who is chatting:
look up their orders, prices or balance, or place an order. Nothing in the code knows a particular
system; each integration is configuration, edited on the dashboard's Integrations page:

- **auth**: an OAuth 2 authorization-code client (`authorize_url`, `token_url`, `client_id`, `scope`,
  `token_format` form or json) plus the client secret. The customer signs in on the system's own page
  in a popup; Replybek stores only that conversation's tokens, encrypted with `SECRET_KEY`, and
  refreshes them when they expire. Passwords never reach Replybek.
- **context**: values read once after sign-in (an account id, a branch), e.g.
  `{ "name": "branch_id", "request": { "path": "/me" }, "pick": "user.branch" }`.
- **account**: which request and field name the signed-in account (shown in the inbox).
- **headers**: sent with every call, e.g. `{ "x-branch": "{{context.branch_id}}" }`. Empty values are left out.
- **tools**: what the agent may do. Each has `name`, `description`, `kind` (`read` runs at once, `write`
  waits for the customer's Confirm on a card), `input` (JSON schema the model fills), `request`
  (`method`, `path`, `body` as a template) and `response` (`json` with `pick`, or `rows` that turns
  `{ data: [[…]] }` into objects with `columns`, with `equals`/`contains` filters). Write tools add
  `confirm`: the card's `title`, `lines` and `total`.

**Two modes.** `server` (the default): Replybek calls the system with a stored OAuth token.
`in_page`: the widget runs inside the system's own page (loaded there as a script) and runs each
request itself, in the signed-in user's session — no OAuth client, no stored secret, nothing sent
to the system to install. Replybek renders the request and hands it to the browser over a poll
channel (`tool_calls`), the browser runs it same-origin with `credentials: include` and posts the
result back. The widget must carry `data-inpage` and send `X-Replybek-Inpage: <origin>`; its origin
must match the integration's `base_url`. Reads run during a backgrounded answer; writes still wait
for the user's Confirm.

Each tool may also set **`when`** (a "when to use" hint shown to the model alongside the description),
and a generic tool may set **`request.allow`** (a regex the rendered path must match — e.g. read-only
endpoints only). Tool results are capped (`TOOL_RESULT_MAX_BYTES`, 16KB) so a big table can't flood the
model; over-large in-page responses are refused with a "narrow it" message. A dry-run preview endpoint,
`POST /w/:wid/integrations/:iid/tools/:name/preview` (admins), renders the exact request a tool would
send for sample `args` (optionally for an unsaved `tool`/`base_url`/`headers`), without calling the system.

Templates: `{{args.x}}` (from the model), `{{context.x}}`, `{{now | date:DD.MM.YYYY HH:mm}}`,
filters `default:`, `number`, `string`, and lists with `{ "$each": "{{args.items}}", "do": { … } }`.
Requests may only go to the integration's own address, and in production only to public hosts.

## Billing (Polar)

Off by default: without `POLAR_ACCESS_TOKEN`, `PATCH /w/:wid/plan` just changes the stored plan (no payment).
With it set, plans change only through Polar, and `PATCH /plan` answers 409.

Quick way: create an organization token in Polar (the scopes below plus `products:read/write` and
`webhooks:read/write`), put it in `.env` as `POLAR_ACCESS_TOKEN`, then run
`npm run polar:setup -- --webhook-url https://<public API address>` (add `--production --out .env.production`
for live). It creates the products (prices from `replybek-app/src/constants.js`) and the webhook, and writes
steps 1 and 3 into the env file. By hand:

1. In Polar, create three monthly products (Starter, Growth, Business). Put their ids in
   `POLAR_PRODUCT_STARTER` / `POLAR_PRODUCT_GROWTH` / `POLAR_PRODUCT_BUSINESS`.
2. Create an organization access token (`checkouts:write`, `subscriptions:write`,
   `customer_sessions:write`) → `POLAR_ACCESS_TOKEN`.
3. Add a webhook endpoint `{PUBLIC_API_URL}/billing/polar/webhook`, format "Raw", with the
   `subscription.*` events; its secret → `POLAR_WEBHOOK_SECRET`.
4. Test against the sandbox first: `POLAR_API_URL=https://sandbox-api.polar.sh/v1` with a sandbox token.

Flow: the owner picks a plan → `POST /w/:wid/billing/checkout {plan}`.
- No running subscription: it creates a Polar checkout (the workspace id is the Polar customer's
  `external_customer_id`, metadata `workspace_id`, back to `#/settings/billing`) and returns `{ url }`.
  When the subscription starts, its webhook sets the plan and stores it as the workspace's subscription.
- A running subscription (trial included) switches product in place (`PATCH /subscriptions/:id`, Polar's
  default proration) and returns `{ changed: true }`. No second checkout.

Every `subscription.*` event goes through one handler: events for the workspace's current subscription
update its plan, status and dates; a different subscription only takes over when it is trialing or
active, and the one it replaces is cancelled at period end. Webhooks are verified (Standard Webhooks HMAC,
5-minute window; both Polar secret formats) and each `webhook-id` is applied once.
`POST /w/:wid/billing/portal` (owner) returns a signed-in link to Polar's customer portal (card, invoices,
cancel). The workspace summary carries `billing: { provider, access, status, renews_at, cancel_at_period_end, can_manage }`.

**Free trial (card required):** the trial is Polar's. The first checkout asks Polar for a 7-day trial;
later checkouts (after a subscription ended) don't. Polar's status is `trialing` during it. Access is
`trial`, `paid` (active, past_due), `none` (no trial started) or `ended`. Before the trial, the
Playground (and onboarding) gets 30 test answers a month (`PREVIEW_MESSAGES`); the website widget doesn't
answer and hands chats to the team. When `ended`, both stop (402). With billing off (no Polar token),
nothing is limited.

## Onboarding

New admins with no agent land in a first-run flow in the dashboard (`#/onboarding`):

1. `POST /w/:wid/onboarding/analyze {url}` (admins) reads the home page: name (og:site_name, JSON-LD,
   or the title part that matches the domain), description, language (`html lang`), a square logo
   (apple-touch-icon, then the largest icon, JSON-LD logo, a header logo image, `/favicon.ico`; stored
   as a `data:` URL, type checked by its bytes, at most 200 KB) and a brand colour (theme-color,
   TileColor, mask-icon, `--brand`/`--primary` tokens, then the most used colourful CSS value). It also
   previews the sitemap and proposes the agent name and welcome in the site's language. Nothing is saved.
2. The dashboard creates the agent, saves `widget.logo`/`accent`/`display_name`, imports the site and
   writes starter questions once it's ready.
3. Trial checkout can return to onboarding (`POST /billing/checkout {plan, return_to: "onboarding"}`).
4. `POST /w/:wid/onboarding/complete` sets `settings.onboarded` (also used by "Skip for now").

## Sign in with Google

`GET /auth/google` starts the OAuth code flow (PKCE, state in a 10-minute cookie); Google returns to
`GOOGLE_REDIRECT_URI` (default `{APP_ORIGIN}/api/auth/google/callback`, so the session cookie lands on
the dashboard's origin). A verified Google email signs into the matching account (linking it) or
creates one with a provisionally named workspace (`settings.auto_named`), which onboarding renames
after the website. Google-only accounts have no password. `GET /auth/providers` tells the sign-in page
whether to show the button. Errors come back as `?auth_error=…` on the dashboard.

## Not built yet

Files of deleted conversations stay in storage until a cleanup job exists; analytics endpoints and
deployment scripts.

### What the AI reads from customers' files

When the AI is handling a chat, a file the customer sends is read just before the answer
(`readForAI` in `services/attachments.service.js`): PDF, DOCX, TXT and CSV text locally, XLSX cells
with `lib/xlsx.js`, and photos and scanned PDFs (no text layer) through the chat model, which
describes what they show and copies their text. Up to 8,000 characters are kept in
`attachments.ai_text`, so later answers in the conversation still know the file. The AI gets it as
the customer's information, never instructions, and only the customer's own words can ask for a
person. Files aren't read while the team has the chat, or once the plan's AI messages run out.

### AI-assisted configuration and saved starter questions

Admins curate `suggested_questions_i18n` (`en`, `uz`, `ru`, up to five questions of 180 characters per language) and `suggestion_default_language`. The legacy `suggested_questions` list remains a fallback. The widget resolves an explicit `data-language`, the website language, then the browser language. A missing translation falls back to the configured default; an explicitly empty list disables suggestions for that language. Nothing generates on page visits. `POST /w/:wid/agents/:aid/suggestions/generate` accepts `language` and optionally `questions` for an explicit translation draft; applying and saving remain separate admin actions. Run migrations for the new columns and draft-job table.

`POST /w/:wid/integrations/ai-draft` accepts JSON or multipart: one of `source`, `url`, or `file`, optional `goal`, and `access_mode` (`auto`, `server`, `browser_session`, `frontend_token`). Documentation with recognized operations returns a complete discovered catalog and, when a goal is provided, an AI proposal containing endpoint IDs, a connection method, requirements and clarification questions. Undocumented endpoint IDs are rejected. The goal describes business tasks and access architecture, not actual credentials. The UI requires unresolved planning questions to be clarified before starting generation.

Readers support Postman collections and public Documenter pages, OpenAPI/Swagger JSON or YAML (local references), ReDoc/Swagger specification links, linked HTML references, and recognizable method/path entries in extracted PDF/DOCX/text/Markdown. Crawling is limited to the same origin, 40 pages and 8 MB. Files/downloads are limited to 2 MB each, pasted input to 60,000 characters, catalogs to 500 endpoints, and each generation context to 180,000 characters. Full shared context, the operation index and selected definitions are retained within that budget; over-budget definitions fail explicitly. Missing pages, unresolved external/recursive references and crawl limits are reported. Arbitrary JavaScript-only or private documentation is not universally readable: upload/export it or supply the relevant reference. Documents go to the configured AI provider; common credential patterns are redacted, but remove secrets and customer data before submission.

`POST /w/:wid/integrations/ai-jobs` snapshots documentation and queues generation in batches of up to three selected endpoints. GET `/ai-jobs/:id` reports persisted progress, successful actions and endpoint failures. POST `/retry` retries incomplete/failed endpoints while retaining successful actions and `/cancel` stops accepting further results. Drafts expire after 24 hours and at most two imports per workspace can run at once. The dashboard can close and resume viewing progress. Large saved action catalogs use search/inspect/execute model tools instead of sending hundreds of schemas on every chat turn.

Generated actions require documented fixed paths; non-GET methods require confirmation, including read-like POST APIs. Drafts do not execute business requests, save a connection, or enable actions. Credentials, arbitrary headers, account lookups, bindings and procedures require review in the existing builder. AI setup is admin-only and limited to six requests per user per minute. Fake AI is a deterministic test fixture, not evidence that every endpoint will generate successfully with a live model.

For browser access, `auth.browser_auth` distinguishes `session` cookies from `host_token`. The latter makes every in-page request require the host application's `window.ReplybekAuth.getToken({ integrationId, method, path })` callback. The widget attaches the returned credential using `auth.header` / `auth.prefix` at request time. Tokens are not stored in integration configuration or sent as chat inputs. Missing/invalid callbacks fail closed; requests must stay on the page's origin and redirects are blocked. Common verbatim/JSON/URL-encoded credential echoes are redacted from results, but business APIs should never return credentials. The host app must supply credentials compatible with the actual API scheme (for example Basic is not interchangeable with an arbitrary bearer token). Cross-origin APIs need a same-origin proxy or server/OAuth setup.
