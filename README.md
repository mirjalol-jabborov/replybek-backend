# Replybek backend

Express + PostgreSQL (pgvector) API for Replybek: workspaces and accounts, agents, knowledge
(websites, files, Q&A), AI answers with sources, the support inbox, and the public API the
chat widget calls from customers' websites. Plain JavaScript (ES modules), the same stack as Habitnex.

## Run locally

Run every command from this folder.

1. `npm install`
2. `npm run db:up` starts Postgres 16 + pgvector in Docker on `localhost:54329` (dev only).
3. Put your OpenAI key in `.env` (see `.env.example`). The database needs no settings locally.
4. `npm run migrate` creates or updates the tables (safe to run again).
5. `npm run dev` serves the API on http://localhost:3100. Knowledge processing runs in the same process.

`npm run smoke` checks the OpenAI key with three tiny calls and never prints it.

## Tests

`npm test` migrates the separate `replybek_test` database and runs everything against a fake
OpenAI (no key, no cost, same result every run). Covered: sign-up and sessions, workspace
isolation, Q&A/website/file knowledge (including robots.txt, private-address blocking and a
real PDF), retries, Playground answers, fallback and unanswered questions, moderation, the
widget → handoff → takeover → reply flow, internal notes never reaching visitors, and usage counting.

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
| POST | `/w/:wid/conversations/:cid/takeover`, `/hand-back`, `/reply`, `/note`, `/assign`, `/resolve`, `/reopen`, `/unread` | Inbox actions |
| GET | `/widget/:key/config` | Public: name, welcome, accent |
| POST | `/widget/:key/conversations` | Public: start a chat, returns `visitor_token` |
| POST / GET | `/widget/:key/conversations/:cid/messages` | Public: send / poll (`X-Visitor-Token`) |
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
for the user's Confirm. For Biruni/Smartup apps, `replybek-widget/biruni-plugin/` builds the per-
project plugin file that loads the widget (no change to the system's business logic).

Each tool may also set **`when`** (a "when to use" hint shown to the model alongside the description),
and a generic tool may set **`request.allow`** (a regex the rendered path must match — e.g. read-only
endpoints only). Tool results are capped (`TOOL_RESULT_MAX_BYTES`, 16KB) so a big table can't flood the
model; over-large in-page responses are refused with a "narrow it" message. A dry-run preview endpoint,
`POST /w/:wid/integrations/:iid/tools/:name/preview` (admins), renders the exact request a tool would
send for sample `args` (optionally for an unsaved `tool`/`base_url`/`headers`), without calling the system.

Templates: `{{args.x}}` (from the model), `{{context.x}}`, `{{now | date:DD.MM.YYYY HH:mm}}`,
filters `default:`, `number`, `string`, and lists with `{ "$each": "{{args.items}}", "do": { … } }`.
Requests may only go to the integration's own address, and in production only to public hosts.

## Not built yet

Live inbox updates (the dashboard polls for now), teammate invites and email, photo messages,
billing (Stripe), analytics endpoints and deployment scripts.
