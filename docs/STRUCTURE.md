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
| `src/agent/answers/` | the model client (`ai.js`), answering, the Playground, suggested questions, translations |
| `src/agent/inbox/` | conversations, chat, attachments, delivery to channels, notifying the team |
| `src/agent/integrations/` | integrations, their config and templates, AI drafts, tests, tool catalog and guard, the in-page bridge, API documentation reading, the OAuth return page |
| `src/agent/channels/` | connecting channels, the Telegram bot, its polling and its API client (`telegram-api.js`), the website widget, channel wording |
| `src/agent/analytics/` | conversation volume |
| `src/agent/onboarding/` | reading the business's site or documents into a first agent |
| `src/crm/` | the CRM product: the host (`index.js`, `modules.js`, `db.js`: every write and its one "after a write" report), core, and the modules booking, store, notices (messages to customers), public (the business's own booking and shop pages), reports, exchange (Excel export and import) and branches (more than one place: which branch a write goes to, who is limited to one, moving goods between them); `shared/` holds the pure rules, mirrored to the CRM app |
| `src/bridge/` | the one place the AI agent and the CRM meet: the CRM tools an answer may use, their confirm cards, who the customer in a chat is. It calls the CRM's exported functions (a module's `index.js`, `core/customers.js`) as a customer (`{ by: "customer", via: "ai" }`); nothing in `src/crm` imports it |
| `src/locales/` | wording a customer reads on messaging channels |
