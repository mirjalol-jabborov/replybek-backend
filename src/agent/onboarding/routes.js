import { Router } from "express";
import multer from "multer";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { rateLimit } from "../../core/rate-limit.js";
import { websitePreviewSchema } from "../knowledge/checks.js";
import { onboardingCompleteSchema } from "./checks.js";
import { analyzeSite, analyzeDocs, completeOnboarding } from "./onboarding.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");

// Onboarding: read the business's website, then (in the dashboard) create the first agent from it.
const analyzeLimit = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => req.user.id, message: "Too many website checks. Wait a minute." });
router.post("/onboarding/analyze", admin, analyzeLimit, validate(websitePreviewSchema), wrap(async (req, res) => res.json(await analyzeSite(req.workspace, req.valid.url))));
// No website: the same proposal, read from the documents the owner picked (up to 10, 20 MB each).
const docsAnalyzeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 } });
router.post("/onboarding/analyze-docs", admin, analyzeLimit, docsAnalyzeUpload.array("file", 10), wrap(async (req, res) => res.json(await analyzeDocs(req.workspace, req.files))));
router.post("/onboarding/complete", admin, validate(onboardingCompleteSchema), wrap(async (req, res) => res.json(await completeOnboarding(req.workspace, req.valid.website))));

export default router;
