import "dotenv/config";
import app from "./app.js";
import { startWorker } from "./services/jobs.service.js";
import { startPollingChannels } from "./services/telegram-polling.service.js";

const PORT = process.env.PORT || 3100;

app.listen(PORT, () => {
  console.log(`Replybek API listening on port ${PORT}`);
  // One server: process knowledge in the same process. Set WORKER_IN_PROCESS=false and run
  // `npm run worker` separately when the API runs on several machines.
  if (process.env.WORKER_IN_PROCESS !== "false") startWorker();
  // Without a public address, connected Telegram bots collect their own updates (see
  // telegram-polling.service.js). With one, Telegram calls the webhook and this does nothing.
  startPollingChannels().catch((e) => console.error("Telegram polling didn't start:", e.message));
});
