import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { testLimit, setupAILimit } from "../limits.js";
import { suggestionDraftSchema, testQuestionSchema } from "./checks.js";
import { getAgent } from "../agents/agents.js";
import { answerQuestion } from "./answer.js";
import { suggestedQuestions, translateQuestions, languageOf } from "./suggestions.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");

router.post("/agents/:aid/suggestions/generate", admin, setupAILimit, validate(suggestionDraftSchema), wrap(async (req, res) => {
  const agent = await getAgent(req.workspace.id, req.params.aid);
  const language = req.valid.language || languageOf(req.headers["accept-language"]);
  res.json(req.valid.questions ? await translateQuestions(req.valid.questions, language) : await suggestedQuestions(agent, language));
}));
// Playground: answers with unsaved settings; nothing is stored except usage.
router.post("/agents/:aid/test", testLimit, validate(testQuestionSchema), wrap(async (req, res) => {
  const agent = await getAgent(req.workspace.id, req.params.aid);
  res.json(await answerQuestion({ agent, question: req.valid.question, history: req.valid.history, draft: req.valid.draft, playground: true }));
}));

export default router;
