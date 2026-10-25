import "dotenv/config";
import { startWorker } from "./services/jobs.service.js";
import "./services/ingest.service.js";

startWorker();
console.log("Replybek worker started.");
