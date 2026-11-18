# Backend structure

Code is grouped by business area. Inside an area folder: `routes.js` (its routes under `/w/:wid`),
`checks.js` (its input checks), its logic files and its own helpers. Routers mounted somewhere
else are named for what calls them (`widget-routes.js`, `telegram-routes.js`, `polar-routes.js`).

| Folder | What lives there |
| --- | --- |
| `src/` | `app.js` (every mount, and the `/w/:wid` order), `server.js` (API + in-process worker), `worker.js` (worker alone) |
| `src/core/` | shared by both products: `db.js`, `db-config.js`, `http.js`, `validate.js`, `error.js`, `not-found.js`, `rate-limit.js`, `events.js` (live updates), `jobs.js`, `storage.js`, `mail.js`, `emails.js`, `languages.js`, `secrets.js`, `clock.js`, `safe-fetch.js` |
| `src/core/auth/` | sign-up, sign-in, Google sign-in, the session cookie and `requireUser` |
| `src/core/workspaces/` | the workspace, its members and plans, products, `access.js` (requireWorkspace, roles, product guard, trial lock) |
| `src/core/team/` | invitations, roles, removing teammates, password reset (`invite-routes.js` for `/invites` and `/auth/password`) |
| `src/core/billing/` | Polar: checkout, portal, sync, the webhook (`polar-routes.js`) |
| `src/core/activity/` | the workspace activity feed and the monthly message count |
| `src/agent/` | the AI agent product |
| `src/agent/shared/` | what two agent areas use: `limits.js` (the Playground/test and AI setup rate limits) |
| `src/agent/agents/` | agents and their settings |
| `src/agent/knowledge/` | sources, website reading (site, robots, sitemap), extraction, ingest, chunks, retrieval |
| `src/agent/answers/` | the model: `ai.js` (the one door: real or test stand-in), `models.js` (model names, vector size), `openai.js` (the real client), `fake-ai.js` (the deterministic stand-in for tests); answering, the Playground, suggested questions, translations |
| `src/agent/inbox/` | conversations, chat, attachments, delivery to channels, notifying the team |
| `src/agent/integrations/` | an integration: `integrations.js` (add, change, remove, list), `definitions.js` (an action's inputs and their checks, `sameAction`), `requests.js` (building and sending a request to the business's system, reading its answer, the preview), `connections.js` (the customer's sign-in and the connection kept per conversation), `in-page.js` (requests run in the customer's own tab; `bridge.js` holds the waiters), `tools.js` (the tools an agent offers, calling and running one), `cards.js` (product cards and their button), `confirmations.js` (Confirm or Cancel of a pending action), `procedures.js` (multi-step procedures and their simulation); import and export: `package.js` (the shareable package, credentials stripped), `import.js` (picks the format), `import-curl.js`, `import-openapi.js`; also templates, AI drafts, tests, tool catalog and guard, API documentation reading, the OAuth return page |
| `src/agent/channels/` | `channels.js` (connecting, listing and loading a channel), `bot-profile.js` (the bot's Telegram profile and greeting buttons), Telegram Business (`business.js`: whose account counts and what Telegram reported; `business-setup.js`: the dashboard's link and status), the Telegram bot (`telegram.js`: one update in, the bot's own chats and taps; `telegram-chat.js`: the conversation, files and answering a burst; `business-chats.js`: the owner's business chats; `chat-queue.js`: one chat's messages in order, one answer per burst), its polling and its API client (`telegram-api.js`), the website widget, channel wording |
| `src/agent/analytics/` | conversation volume |
| `src/agent/onboarding/` | reading the business's site or documents into a first agent |
| `src/crm/` | the CRM product: the host (`index.js`, `modules.js`, `db.js`: every write and its one "after a write" report), core, and the modules booking, store, notices (messages to customers), public (the business's own booking and shop pages), reports, exchange (Excel export and import) and branches (more than one place: which branch a write goes to, who is limited to one, moving goods between them); `shared/` holds the pure rules, mirrored to the CRM app |
| `src/bridge/` | the one place the AI agent and the CRM meet: the CRM tools an answer may use, their confirm cards, who the customer in a chat is. It calls the CRM's exported functions (a module's `index.js`, `core/customers.js`) as a customer (`{ by: "customer", via: "ai" }`); nothing in `src/crm` imports it |
| `src/locales/` | wording a customer reads on messaging channels |

A file does one job and stays around 300 lines; past that it is split by the thing each part handles.
State kept in memory lives in one file each: the in-page waiters in `integrations/bridge.js`, the Telegram chat queues in
`channels/chat-queue.js`, the polling loops in `channels/polling.js`, the OpenAI client in `answers/openai.js`, the test
stand-in (its counters and switches, `fakeAI`) in `answers/fake-ai.js`, the input-schema compiler in `integrations/definitions.js`.
