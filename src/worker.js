import "dotenv/config";
import { startWorker } from "./core/jobs.js";
import "./agent/knowledge/ingest.js";
import "./agent/integrations/ai-jobs.js";
import "./crm/booking/series-job.js"; // keeps repeat bookings booked ahead
import "./crm/index.js"; // the CRM's modules: writes made here are heard (Notices), and due messages are sent
import "./agent/channels/notice-sender.js"; // ...through the Telegram bot too

startWorker();
console.log("Replybek worker started.");
