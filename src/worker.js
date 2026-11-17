import "dotenv/config";
import { startWorker } from "./core/jobs.js";
import "./agent/knowledge/ingest.js";
import "./agent/integrations/ai-jobs.js";
import "./crm/booking/series-job.js"; // keeps repeat bookings booked ahead

startWorker();
console.log("Replybek worker started.");
