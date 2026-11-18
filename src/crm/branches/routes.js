// The branches' routes, mounted at /w/:wid/crm. A route only parses, checks the role and calls.
// Setting up branches and who works where is for admins and the owner; moving goods between
// branches is stock work, open to the team.
import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { branchCreateSchema, branchUpdateSchema, memberSchema, createBranch, updateBranch, deleteBranch, limitMember } from "./branches.js";
import { transferSchema, transferStock } from "./transfer.js";

export const router = Router({ mergeParams: true });
const admin = requireRole("admin");
const wid = (req) => req.workspace.id;
/** A route that answers with what the entity file returns. */
const route = (fn, status = 200) => wrap(async (req, res) => res.status(status).json(await fn(req)));

router.post("/branches", admin, validate(branchCreateSchema), route((req) => createBranch(wid(req), req.valid), 201));
router.put("/branches/members/:userId", admin, validate(memberSchema), route((req) => limitMember(wid(req), req.params.userId, req.valid)));
router.put("/branches/:id", admin, validate(branchUpdateSchema), route((req) => updateBranch(wid(req), req.params.id, req.valid)));
router.delete("/branches/:id", admin, route((req) => deleteBranch(wid(req), req.params.id)));

router.post("/stock/transfer", validate(transferSchema), route((req) => transferStock(req.workspace, { ...req.user, branchOnly: req.branchOnly }, req.valid)));
