import { query, tx } from "../db.js";
import { HttpError, notFound } from "../lib/http.js";
import { enqueue, registerJob } from "./jobs.service.js";
import { readDocumentation, generateFromDocumentation, redactDocumentation } from "./integration-ai.service.js";
import { selectedDocumentation } from "../lib/documentation.js";

const sanitize = value => typeof value === "string" ? redactDocumentation(value) : Array.isArray(value) ? value.map(sanitize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)])) : value;
async function own(workspaceId, id) {
  if(!/^[a-f0-9-]{36}$/i.test(id))throw notFound("Draft not found");
  const row=(await query("SELECT * FROM integration_ai_drafts WHERE id=$1 AND workspace_id=$2 AND expires_at>now()",[id,workspaceId])).rows[0];
  if(!row)throw notFound("Draft not found or expired");return row;
}
export async function startIntegrationDraft(workspaceId, userId, input, file, language) {
  if(!input.endpoint_ids?.length)throw new HttpError(400,"Select endpoints before generating.");
  if(new Set(input.endpoint_ids).size!==input.endpoint_ids.length)throw new HttpError(400,"Select each endpoint only once.");
  const docs=await readDocumentation({...input,endpoint_ids:[]},file);
  if(!docs.collection)throw new HttpError(400,"Read the endpoint catalog before starting this import.");
  const selected=input.endpoint_ids.map(id=>docs.collection.endpoints.find(e=>e.id===id));
  if(selected.some(e=>!e?.supported))throw new HttpError(400,"The endpoint selection changed. Read the documentation again.");
  const snapshot=sanitize(docs.collection);
  snapshot.access_mode = input.access_mode || "auto";
  if(JSON.stringify(snapshot).length>20*1024*1024)throw new HttpError(413,"The expanded documentation is too large. Split it into smaller references.");
  // Each endpoint keeps its complete definition; batches shrink rather than truncating context.
  const batches=[];
  let current=[];
  for(const e of selected){
    if(current.length){try{selectedDocumentation(snapshot,[...current,e.id]);}catch{batches.push(current);current=[];}}
    current.push(e.id);
    if(current.length>=3){batches.push(current);current=[];}
  }
  if(current.length)batches.push(current);
  await query("DELETE FROM integration_ai_drafts WHERE expires_at<now()");
  const id=await tx(async db=>{
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE",[workspaceId]);
    const active=await db.query("SELECT count(*)::int AS n FROM integration_ai_drafts WHERE workspace_id=$1 AND status='running'",[workspaceId]);
    if(active.rows[0].n>=2)throw new HttpError(429,"Finish or cancel an existing integration draft before starting another.");
    const row=(await db.query("INSERT INTO integration_ai_drafts(workspace_id,created_by,source,goal,language,snapshot,batches) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[workspaceId,userId,docs.origin,redactDocumentation(input.goal),language,snapshot,JSON.stringify(batches)])).rows[0];
    for(let index=0;index<batches.length;index++)await enqueue("integration_ai_batch",{draft_id:row.id,index,revision:0},db);
    return row.id;
  });
  return getIntegrationDraft(workspaceId,id);
}

export function assembleDraft(row) {
  const total=row.batches.flat().length, entries=Object.values(row.results), completed=entries.reduce((n,r)=>n+r.endpoint_ids.length,0);
  const warnings=new Set(),missing=new Set(),tools=[],evidence=[],failed=[];
  let integration=null;
  for(const result of entries){
    for(const w of result.warnings || [])warnings.add(w);
    for(const m of result.missing || [])missing.add(m);
    if(result.error){failed.push(...result.endpoint_ids.map(id=>({id,name:row.snapshot.endpoints.find(e=>e.id===id)?.name || id,error:result.error})));continue;}
    if(!result.integration){failed.push(...result.endpoint_ids.map(id=>({id,name:row.snapshot.endpoints.find(e=>e.id===id)?.name || id,error:"No valid action was generated."})));continue;}
    if(!integration){integration={...result.integration,tools:[],enabled:false};try{integration.base_url=new URL(integration.base_url).origin;}catch{}}
    for(const tool of result.integration.tools){
      const path=tool.request.path.split("?")[0].replace(/\{\{args\.([\w]+)(?:\s*\|\s*url)?\}\}/g,"{$1}");
      const endpoint=row.snapshot.endpoints.find(e=>result.endpoint_ids.includes(e.id)&&e.method===tool.request.method&&(result.integration.base_url.replace(/\/$/,"")+path===e.base+e.path || (!result.integration.base_url&&path===e.path)));
      if(!endpoint)continue;
      if(result.integration.base_url!==integration.base_url){
        // Normalize base-path differences on the same API host, never combine different hosts.
        try {if(new URL(result.integration.base_url).origin!==new URL(integration.base_url).origin)throw new Error();}
        catch {failed.push({id:endpoint.id,name:endpoint.name,error:"This endpoint uses a different API host. Configure it in a separate integration."});continue;}
      }
      const name=`${tool.name.slice(0,38)}_${endpoint.id.slice(0,8)}`;
      const absolute=result.integration.base_url.replace(/\/$/,"")+tool.request.path;
      const base=integration.base_url.replace(/\/$/,"");
      if(!absolute.startsWith(base+"/")){failed.push({id:endpoint.id,name:endpoint.name,error:"The API base path differs. Configure this endpoint separately."});continue;}
      tools.push({...tool,name,request:{...tool.request,path:absolute.slice(base.length)}});
      const citation=result.evidence?.find(e=>e.name===tool.name);if(citation)evidence.push({...citation,name});
    }
    for(const id of result.endpoint_ids){const e=row.snapshot.endpoints.find(e=>e.id===id);if(!tools.some(t=>t.name.endsWith(id.slice(0,8)))&&!failed.some(f=>f.id===id))failed.push({id,name:e?.name || id,error:"The endpoint could not be generated. Review its documentation or retry."});}
  }
  if(integration)integration.tools=tools;
  const coverage=row.snapshot.coverage || {read:1,failed:[],limited:false};
  if(coverage.failed?.length)warnings.add(`${coverage.failed.length} documentation pages could not be read. Review coverage before enabling.`);
  if(coverage.limited)warnings.add("Documentation discovery reached its page/size limit. Coverage is incomplete.");
  if(coverage.unresolved_refs?.length)warnings.add("Some external or recursive schemas need manual review.");
  return {id:row.id,status:row.status,source:row.source,total,completed,generated:tools.length,failed,coverage,
    integration:tools.length?integration:null,evidence,warnings:[...warnings],missing:[...missing],discovered_count:row.snapshot.endpoints.length,selected_count:total};
}
export async function getIntegrationDraft(workspaceId,id){return assembleDraft(await own(workspaceId,id));}
export async function cancelIntegrationDraft(workspaceId,id){await own(workspaceId,id);await query("UPDATE integration_ai_drafts SET status='cancelled',revision=revision+1 WHERE id=$1 AND status='running'",[id]);return getIntegrationDraft(workspaceId,id);}
export async function retryIntegrationDraft(workspaceId,id){
  await own(workspaceId,id);
  await tx(async db=>{const row=(await db.query("SELECT * FROM integration_ai_drafts WHERE id=$1 FOR UPDATE",[id])).rows[0];if(row.status==='running')throw new HttpError(409,"This import is still running.");
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
    const active = await db.query("SELECT count(*)::int AS n FROM integration_ai_drafts WHERE workspace_id=$1 AND status='running'", [workspaceId]);
    if (active.rows[0].n >= 2) throw new HttpError(429, "Finish or cancel an existing integration draft before retrying.");
    const batches = [], results = {};
    for (let index = 0; index < row.batches.length; index++) {
      const ids = row.batches[index], result = row.results[index];
      const failed = new Set(result ? assembleDraft({...row, results: {[index]: result}}).failed.map(e => e.id) : ids);
      const successful = ids.filter(id => !failed.has(id));
      if (successful.length) { results[batches.length] = {...result, endpoint_ids: successful}; batches.push(successful); }
      const remaining = ids.filter(id => failed.has(id));
      if (remaining.length) batches.push(remaining);
    }
    const retryIndices = batches.map((_,i) => i).filter(i => !results[i]);
    await db.query("UPDATE integration_ai_drafts SET batches=$2,results=$3,status=$4,revision=revision+1,expires_at=now()+interval '24 hours' WHERE id=$1", [id, JSON.stringify(batches), results, retryIndices.length ? 'running' : 'complete']);
    for (const index of retryIndices) await enqueue("integration_ai_batch", {draft_id:id,index,revision:row.revision+1}, db);
  });return getIntegrationDraft(workspaceId,id);
}

registerJob("integration_ai_batch",async ({draft_id,index,revision},{heartbeat})=>{
  const row=(await query("SELECT * FROM integration_ai_drafts WHERE id=$1 AND expires_at>now()",[draft_id])).rows[0];
  if(!row||row.status!=='running'||row.revision!==revision||row.results[index])return;
  const ids=row.batches[index];
  let result;
  try {
    const selected=selectedDocumentation(row.snapshot,ids);
    await heartbeat();
    const draft=await generateFromDocumentation({goal:row.goal,endpoint_ids:ids,access_mode:row.snapshot.access_mode},{origin:row.source,text:selected.text,warnings:selected.warnings,catalog:{count:row.snapshot.endpoints.length},selected_endpoints:selected.selected.map(({base,method,path})=>({base,method,path}))},row.language);
    result={...draft,endpoint_ids:ids};
  }catch(e){result={endpoint_ids:ids,error:e instanceof HttpError?e.message:"AI generation failed for this batch. Retry when the AI service is available."};}
  await tx(async db=>{
    const current=(await db.query("SELECT * FROM integration_ai_drafts WHERE id=$1 FOR UPDATE",[draft_id])).rows[0];
    if(!current||current.status!=='running'||current.revision!==revision)return;
    const results={...current.results,[index]:result};
    const assembled=assembleDraft({...current,results});
    const status=Object.keys(results).length===current.batches.length?(assembled.failed.length?'partial':'complete'):'running';
    await db.query("UPDATE integration_ai_drafts SET results=$2,status=$3 WHERE id=$1",[draft_id,results,status]);
  });
});
