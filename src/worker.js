import "dotenv/config";
import { startWorker } from "./core/jobs.js";
import "./agent/knowledge/ingest.js";
import "./agent/integrations/ai-jobs.js";

startWorker();
console.log("Replybek worker started.");
