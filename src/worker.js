import "dotenv/config";
import { startWorker } from "./core/jobs.js";
import "./services/ingest.service.js";
import "./services/integration-ai-jobs.service.js";

startWorker();
console.log("Replybek worker started.");
