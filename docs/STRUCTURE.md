# Backend structure

Code is grouped by business area. Inside an area folder: `routes.js` (its routes under `/w/:wid`),
`checks.js` (its input checks), its logic files and its own helpers. Routers mounted somewhere
else are named for what calls them (`widget-routes.js`, `telegram-routes.js`, `polar-routes.js`).

| Folder | What lives there |
| --- | --- |
| `src/` | `app.js` (every mount, and the `/w/:wid` order), `server.js` (API + in-process worker), `worker.js` (worker alone) |
| `src/core/` | shared by both products: `db.js`, `db-config.js`, `http.js`, `validate.js`, `error.js`, `not-found.js`, `rate-limit.js`, `events.js` (live updates), `jobs.js`, `storage.js`, `mail.js`, `emails.js`, `telegram.js` (Telegram API client), `languages.js`, `secrets.js`, `clock.js`, `safe-fetch.js` |
| `src/core/auth/` | sign-up, sign-in, Google sign-in, the session cookie and `requireUser` |
| `src/core/workspaces/` | the workspace, its members and plans, products, `access.js` (requireWorkspace, roles, product guard, trial lock) |
| `src/core/team/` | invitations, roles, removing teammates, password reset (`invite-routes.js` for `/invites` and `/auth/password`) |
| `src/core/billing/` | Polar: checkout, portal, sync, the webhook (`polar-routes.js`) |
| `src/core/activity/` | the workspace activity feed and the monthly message count |
| `src/agent/` | the AI agent product; `limits.js` holds the rate limits its areas share |
| `src/agent/agents/` | agents and their settings |
| `src/agent/knowledge/` | sources, website reading (site, robots, sitemap), extraction, ingest, chunks, retrieval |
| `src/agent/answers/` | the model client (`ai.js`), answering, the Playground, suggested questions, translations |
| `src/agent/inbox/` | conversations, chat, attachments, delivery to channels, notifying the team |
| `src/agent/integrations/` | integrations, their config and templates, AI drafts, tests, tool catalog and guard, the in-page bridge, API documentation reading, the OAuth return page |
| `src/agent/channels/` | connecting channels, the Telegram bot and its polling, the website widget, channel wording |
| `src/agent/analytics/` | conversation volume |
| `src/agent/onboarding/` | reading the business's site or documents into a first agent |
| `src/crm/` | the CRM product: host, core, booking, store, shared rules |
| `src/locales/` | wording a customer reads on messaging channels |

Until `src/crm` imports `src/core` directly, a few old paths stay as one-line re-exports for it:
`src/db.js`, `src/validators.js`, `src/lib/http.js`, `src/lib/storage.js`,
`src/middlewares/workspace.js`, `src/services/jobs.service.js`, `src/services/events.service.js`.
