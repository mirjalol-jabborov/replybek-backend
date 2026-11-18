import { query } from "../../core/db.js";
import { render, pick } from "./template.js";
import { validateDefinitions, resolveInputs, sameAction } from "./definitions.js";
import { readResponse } from "./requests.js";
import { connection, ensureServerContext } from "./connections.js";
import { safeOrigin, ensureInPageContext } from "./in-page.js";
import { runTool } from "./tools.js";

export function conditionMatches(condition, scope) {
  if (!condition) return true;
  const value = pick(scope, condition.path);
  if (condition.op === "exists") return value !== null && value !== undefined && value !== "";
  if (condition.op === "equals") return JSON.stringify(value) === JSON.stringify(condition.value);
  if (condition.op === "not_equals") return JSON.stringify(value) !== JSON.stringify(condition.value);
  if (condition.op === "greater_than") return typeof value === "number" && value > Number(condition.value);
  if (condition.op === "less_than") return typeof value === "number" && value < Number(condition.value);
  return false;
}
export async function startProcedure({ conversationId, integration, procedure, args, inpageOrigin }) {
  if (!conversationId) return { output: { error: "test_context_required", message: "Simulate this procedure in the integration test panel." } };
  try { args = resolveInputs(procedure, args); } catch (e) { return { output: { error: "invalid_inputs", message: e.message } }; }
  if (integration.mode === "in_page") {
    if (!inpageOrigin || safeOrigin(integration.base_url) !== inpageOrigin) return {output:{error:"not_in_app",message:"Open the chat inside the connected system to run this procedure."}};
    await ensureInPageContext(integration,conversationId);
  } else if (["none","api_key"].includes(integration.auth?.type)) await ensureServerContext(integration,conversationId);
  else if (!(await connection(integration.id,conversationId))) return {output:{error:"not_signed_in",message:"Sign in before starting this procedure."},card:{type:"connect",integration_id:integration.id,name:integration.name}};
  const row = (await query("INSERT INTO procedure_runs (conversation_id, integration_id, definition, args) VALUES ($1,$2,$3,$4) RETURNING *", [conversationId, integration.id, { procedure, tools: integration.tools, revision: integration.config_revision }, args])).rows[0];
  return advanceProcedure(row, integration, inpageOrigin);
}
async function saveRun(run, status) {
  run.status = status;
  await query("UPDATE procedure_runs SET results=$2, trace=$3, step_index=$4, status=$5, updated_at=now() WHERE id=$1", [run.id, run.results, JSON.stringify(run.trace), run.step_index, status]);
}
async function advanceProcedure(run, integration, inpageOrigin) {
  if (run.definition.revision !== integration.config_revision) {
    await saveRun(run, "failed"); return { output: { error: "configuration_changed", message: "The connection changed. Start the procedure again." } };
  }
  const p = run.definition.procedure;
  for (; run.step_index < p.steps.length; run.step_index++) {
    const step = p.steps[run.step_index]; const scope = { args: run.args, steps: run.results, context: (await connection(integration.id,run.conversation_id))?.context || {}, now: new Date() };
    if (!conditionMatches(step.condition, scope)) {
      run.trace.push({ step: step.id, status: step.kind === "check" ? "failed" : "skipped" });
      if (step.kind === "check") { await saveRun(run, "failed"); return { output: { error:"condition_failed", message:step.message || "The procedure's requirements were not met.", trace:run.trace } }; }
      continue;
    }
    if (step.kind === "check") { run.trace.push({ step:step.id, status:"passed" }); continue; }
    const tool = run.definition.tools.find(t => t.name === step.tool);
    const current = integration.tools.find(t => t.name === step.tool);
    if (!tool || !sameAction(tool, current)) { await saveRun(run, "failed"); return { output: { error:"configuration_changed", message:"The action changed. Start the procedure again." } }; }
    let result;
    try { result = await runTool({ conversationId:run.conversation_id, integration, tool, args:render(step.args, scope), inpageOrigin, steps:run.results }); }
    catch { result = { output: { error:"failed", message:"The action did not complete. Check the connected system before retrying." } }; }
    if (result.card?.type === "confirm") {
      await query("UPDATE pending_actions SET procedure_run_id=$2 WHERE id=$1", [result.card.action_id,run.id]);
      run.trace.push({step:step.id,status:"waiting_for_confirmation"}); await saveRun(run,"waiting"); return result;
    }
    if (result.card || result.output?.error) { run.trace.push({step:step.id,status:"failed"}); await saveRun(run,"failed"); return result; }
    run.results[step.id] = result.output; run.trace.push({step:step.id,status:"completed"});
    await saveRun(run,"running");
  }
  await saveRun(run,"completed"); return { output:{ status:"completed", results:run.results, trace:run.trace } };
}
export async function resumeProcedure(id, outcome, inpageOrigin) {
  const run = (await query("UPDATE procedure_runs SET status='running' WHERE id=$1 AND status='waiting' RETURNING *", [id])).rows[0];
  if (!run) return null;
  if (outcome.status !== "done") { await saveRun(run,outcome.status === "cancelled" ? "cancelled" : "failed"); return {output:{status:run.status}}; }
  const step = run.definition.procedure.steps[run.step_index]; run.results[step.id] = outcome.result;
  run.trace.push({step:step.id,status:"completed"}); run.step_index++;
  const integration = (await query("SELECT * FROM integrations WHERE id=$1 AND enabled", [run.integration_id])).rows[0];
  if (!integration) { await saveRun(run,"failed"); return {output:{error:"disabled",message:"The integration was turned off."}}; }
  return advanceProcedure(run,integration,inpageOrigin);
}

/** Deterministic simulation: never calls a system, including for write steps. */
export function simulateProcedure({procedure, tools, args, context, mocks}) {
  validateDefinitions({tools,procedures:[procedure]}); args = resolveInputs(procedure,args);
  const results={}, trace=[];
  for (const step of procedure.steps) {
    const scope={args,context,steps:results,now:new Date()};
    if (!conditionMatches(step.condition,scope)) { trace.push({step:step.id,status:step.kind === "check" ? "failed":"skipped"}); if(step.kind === "check") return {ok:false,trace,message:step.message || "Condition not met"}; continue; }
    if(step.kind === "check") { trace.push({step:step.id,status:"passed"}); continue; }
    const tool=tools.find(t=>t.name===step.tool);
    const inputs=resolveInputs(tool,render(step.args,scope),context,results);
    if (!(step.id in mocks)) return {ok:false,trace,message:`Add a mock response for step ${step.id}.`};
    const mock=mocks[step.id];
    if (mock?.error) {trace.push({step:step.id,status:"failed",error:mock.error});return {ok:false,trace};}
    results[step.id]=readResponse(tool.response,mock,{...scope,args:inputs});
    trace.push({step:step.id,status:"simulated",confirmation_required:tool.kind === "write",result:results[step.id]});
  }
  return {ok:true,results,trace,mode:"mock"};
}
