import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { owner, drainJobs, query } from "./helpers/setup.js";
import { fakeAI } from "../src/ai.js";
import { savedQuestions } from "../src/services/suggestions.service.js";
import { structuredDocumentation, readDocumentationSite } from "../src/lib/documentation-site.js";
import { postmanDocumentation, selectedDocumentation } from "../src/lib/documentation.js";
import { runOne } from "../src/services/jobs.service.js";
import { toolInterface } from "../src/lib/tool-catalog.js";

const collection = count => ({info:{name:"Records API",description:"API base URL https://api.example.com\nPublic API; no authentication required."},item:Array.from({length:count},(_,i)=>({name:`Record ${i}`,request:{method:"GET",url:`https://api.example.com/records/${i}`,description:`Read record ${i}. Inputs and response are documented here.`,body:{mode:"raw",raw:"{}"}}}))});
async function setup(){const o=await owner();const base=`/w/${o.ws.id}`;const agent=(await o.b.call("POST",base+"/agents",{name:"Support"})).body;return {...o,base,agent};}
async function newJob(o,count=63){const source=JSON.stringify(collection(count));const catalog=(await o.b.call("POST",o.base+"/integrations/ai-draft",{source})).body.catalog;const r=await o.b.call("POST",o.base+"/integrations/ai-jobs",{source,endpoint_ids:catalog.endpoints.map(e=>e.id)});assert.equal(r.status,202,JSON.stringify(r.body));return r.body;}

test("multilingual questions persist independently, use fallback, and translate only on request",async()=>{
  const o=await setup(),path=`${o.base}/agents/${o.agent.id}`;
  const q={en:["How do I book?"],uz:["Qanday buyurtma beraman?"]};
  const save=await o.b.call("PATCH",path,{suggested_questions_i18n:q,suggestion_default_language:"en"});assert.equal(save.status,200);
  assert.deepEqual(savedQuestions(save.body,"uz"),q.uz);assert.deepEqual(savedQuestions(save.body,"ru"),q.en);
  const before=fakeAI.calls.chat;
  await o.b.call("GET",path);assert.equal(fakeAI.calls.chat,before);
  const translated=await o.b.call("POST",path+"/suggestions/generate",{language:"ru",questions:q.en},{"Accept-Language":"uz"});
  assert.match(translated.body.questions[0],/^\[ru\]/);
  assert.deepEqual((await o.b.call("GET",path)).body.suggested_questions_i18n,q);
  const empty=await o.b.call("PATCH",path,{suggested_questions_i18n:{...q,ru:[]}});assert.deepEqual(savedQuestions(empty.body,"ru"),[]);
  await o.b.call("POST",path+"/publish");
  const config=await o.b.call("GET",`/widget/${o.agent.public_key}/config?lang=uz`);assert.deepEqual(config.body.suggestions,q.uz);
});

test("all 63 selected endpoints generate in persisted batches and can be saved together",async()=>{
  const o=await setup(),job=await newJob(o);
  assert.equal(job.total,63);assert.equal(job.completed,0);
  await runOne();
  const progress=(await o.b.call("GET",`${o.base}/integrations/ai-jobs/${job.id}`)).body;
  assert.equal(progress.completed,3);assert.equal(progress.status,"running");
  await drainJobs();
  const done=(await o.b.call("GET",`${o.base}/integrations/ai-jobs/${job.id}`)).body;
  assert.equal(done.status,"complete",JSON.stringify(done.failed));assert.equal(done.generated,63);assert.equal(new Set(done.integration.tools.map(t=>t.name)).size,63);
  const saved=await o.b.call("POST",o.base+"/integrations",{...done.integration,agent_id:o.agent.id,auth:{type:"none"},enabled:false});assert.equal(saved.status,201,JSON.stringify(saved.body));assert.equal(saved.body.tools.length,63);
  const other=await setup();assert.equal((await other.b.call("GET",`${other.base}/integrations/ai-jobs/${job.id}`)).status,404);
});

test("cancelled generation stops queued work and can resume without losing completed batches",async()=>{
  const o=await setup(),job=await newJob(o,9);await runOne();
  await o.b.call("POST",`${o.base}/integrations/ai-jobs/${job.id}/cancel`,{});await drainJobs();
  let state=(await o.b.call("GET",`${o.base}/integrations/ai-jobs/${job.id}`)).body;assert.equal(state.status,"cancelled");assert.equal(state.completed,3);
  await o.b.call("POST",`${o.base}/integrations/ai-jobs/${job.id}/retry`,{});await drainJobs();state=(await o.b.call("GET",`${o.base}/integrations/ai-jobs/${job.id}`)).body;assert.equal(state.status,"complete");assert.equal(state.generated,9);
});

test("a failed batch is explicit and retry preserves other generated endpoints",async()=>{
  const o=await setup(),job=await newJob(o,6),original=fakeAI.chatJSON;
  try{fakeAI.chatJSON=async args=>{if(args.meta?.selected_endpoints?.some(e=>e.path==="/records/0"))throw new Error("Fixture failure");return original(args);};await drainJobs();}finally{fakeAI.chatJSON=original;}
  let state=(await o.b.call("GET",`${o.base}/integrations/ai-jobs/${job.id}`)).body;assert.equal(state.status,"partial");assert.equal(state.failed.length,3);assert.equal(state.generated,3);
  await o.b.call("POST",`${o.base}/integrations/ai-jobs/${job.id}/retry`,{});await drainJobs();state=(await o.b.call("GET",`${o.base}/integrations/ai-jobs/${job.id}`)).body;assert.equal(state.generated,6);assert.equal(state.status,"complete");
});

test("large action catalogs browse and inspect schemas while preserving the normal execution path",async()=>{
  const entries=Array.from({length:150},(_,i)=>({tool:{name:`action_${i}`,description:`Read record ${i}`,input:{type:"object",properties:{id:{type:"string"}}}}}));let executed;
  const model=toolInterface(entries,async(name,args)=>{executed={name,args};return {ok:true};});assert.equal(model.tools.length,3);
  const found=await model.run("__replybek_find_actions",{query:"action_149"});assert.equal(found.actions[0].name,"action_149");
  const schema=await model.run("__replybek_describe_action",{name:"action_149"});assert.equal(schema.parameters.properties.id.type,"string");
  await model.run("__replybek_execute_action",{name:"action_149",args:{id:"x"}});assert.deepEqual(executed,{name:"action_149",args:{id:"x"}});
  assert.equal((await model.run("__replybek_execute_action",{name:"unknown",args:{}})).error,"unknown_tool");
});

test("OpenAPI resolves shared schemas and preserves auth, request, response and server context",()=>{
  const schema = { $ref: "#/components/schemas/Order" };
  const spec = {
    openapi: "3.0.3", info: { title: "Shared API" }, servers: [{ url: "https://api.example.com/v1" }], security: [{ BasicAuth: [] }],
    components: { securitySchemes: { BasicAuth: { type: "http", scheme: "basic" } }, schemas: { Order: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"] } } },
    paths: { "/orders": { post: { summary: "Create order", requestBody: { content: { "application/json": { schema } } }, responses: { "200": { description: "Created", content: { "application/json": { schema } } } } } } },
  };
  const docs=structuredDocumentation(JSON.stringify(spec));assert.equal(docs.endpoints[0].path,"/v1/orders");assert.equal(docs.endpoints[0].auth_type,"basic");
  const context=selectedDocumentation(docs,[docs.endpoints[0].id]);assert.match(context.text,/reference/);assert.match(context.text,/responses/);assert.equal(docs.coverage.unresolved_refs.length,0);
});

test("shared and endpoint context is preserved beyond previous truncation boundaries",()=>{
  const raw=collection(1);raw.info.description="A".repeat(9000)+" SHARED_CONTEXT_END";raw.item[0].request.description="B".repeat(15000)+" ENDPOINT_CONTEXT_END";
  const docs=postmanDocumentation(JSON.stringify(raw)),text=selectedDocumentation(docs,[docs.endpoints[0].id]).text;assert.match(text,/SHARED_CONTEXT_END/);assert.match(text,/ENDPOINT_CONTEXT_END/);
});

test("ReDoc discovers a specification and linked HTML documentation reports missing pages",async()=>{
  const calls=[];
  const server=http.createServer((req,res)=>{calls.push(req.url);
    if(req.url==="/openapi.json")return res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({openapi:"3.0.0",info:{title:"Reference"},paths:{"/items":{get:{summary:"Items"}}}}));
    if(req.url==="/docs/auth")return res.writeHead(200,{"content-type":"text/html"}).end("<main>Authentication requires a tenant-scoped API key. Use the tenant header for every request.</main>");
    if(req.url==="/docs/missing")return res.writeHead(404).end();
    res.writeHead(200,{"content-type":"text/html"}).end("<main>GET /items returns items. <a href='/docs/auth'>Authentication</a><a href='/docs/missing'>Reference</a></main>");});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    const spec=await readDocumentationSite({url:origin+"/reference",status:200,type:"text/html",body:Buffer.from('<redoc spec-url="/openapi.json"></redoc>')});assert.equal(spec.format,"openapi");assert.equal(spec.endpoints.length,1);
    const html=await readDocumentationSite({url:origin+"/docs/",status:200,type:"text/html",body:Buffer.from("<main>GET /items returns items. <a href='/docs/auth'>Authentication</a><a href='/docs/missing'>Reference</a></main>")});
    assert.match(html.overview,/tenant-scoped/);assert.equal(html.coverage.failed.length,1);assert.equal(html.endpoints.length,1);assert.ok(!calls.includes("/items"));
  }finally{await new Promise(r=>server.close(r));}
});

test("goal planning proposes catalog actions, clarifies ambiguous UI auth, and preserves an explicit frontend-token choice", async () => {
  const o = await setup(), source = JSON.stringify(collection(4));
  const ambiguous = await o.b.call("POST", o.base + "/integrations/ai-draft", { source, goal: "Read records. We will send auth data from the UI level." });
  assert.equal(ambiguous.status, 200);
  assert.equal(ambiguous.body.plan.access_mode, "unknown");
  assert.ok(ambiguous.body.plan.questions.length);
  const planned = await o.b.call("POST", o.base + "/integrations/ai-draft", { source, goal: "Read records as the signed-in user", access_mode: "frontend_token" });
  assert.equal(planned.body.plan.access_mode, "frontend_token");
  assert.equal(planned.body.plan.endpoint_ids.length, 4);
  const started = await o.b.call("POST", o.base + "/integrations/ai-jobs", { source, goal: "Read records as the signed-in user", access_mode: "frontend_token", endpoint_ids: planned.body.plan.endpoint_ids });
  await drainJobs();
  const done = (await o.b.call("GET", `${o.base}/integrations/ai-jobs/${started.body.id}`)).body;
  assert.equal(done.integration.mode, "in_page");
  assert.equal(done.integration.auth.browser_auth, "host_token");
  assert.match(done.missing.join(" "), /ReplybekAuth.getToken/);
  const saved = await o.b.call("POST", o.base + "/integrations", { ...done.integration, agent_id: o.agent.id });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.auth.browser_auth, "host_token");
  assert.equal(saved.body.has_client_secret, false);
});

test("planning rejects invented endpoints and preserves full shared context", async () => {
  const o = await setup(), raw = collection(2), original = fakeAI.chatJSON;
  raw.info.description = "Shared policy ".repeat(1000) + "SHARED_CONTEXT_END";
  let captured;
  try {
    fakeAI.chatJSON = async args => {
      captured = args.user;
      return { summary: "Read records", endpoint_ids: ["000000000000000000000000"], access_mode: "server", questions: [], requirements: [] };
    };
    const r = await o.b.call("POST", o.base + "/integrations/ai-draft", { source: JSON.stringify(raw), goal: "Read records" });
    assert.equal(r.status, 502);
    assert.match(captured, /SHARED_CONTEXT_END/);
    assert.match(captured, /records\/1/);
  } finally { fakeAI.chatJSON = original; }
});

test("text documentation discovers all operations without a ten-endpoint user limit", async () => {
  const o = await setup();
  const source = "API base URL https://api.example.com\nAPI key authentication.\n" + Array.from({length: 27}, (_,i) => `GET /records/${i} reads record ${i}.`).join("\n");
  const r = await o.b.call("POST", o.base + "/integrations/ai-draft", {source, goal: "Read every record endpoint"});
  assert.equal(r.body.catalog.count, 27); assert.equal(r.body.plan.endpoint_ids.length, 27);
});

test("retrying a partial batch retains successful actions and regenerates only missing endpoints", async () => {
  const o = await setup(), job = await newJob(o, 3), original = fakeAI.chatJSON;
  try {
    fakeAI.chatJSON = async args => {
      const result = await original(args);
      if (args.meta?.task === "integration_draft") result.integration.tools = result.integration.tools.filter(t => t.request.path !== "/records/1");
      return result;
    };
    await drainJobs();
  } finally { fakeAI.chatJSON = original; }
  const before = (await o.b.call("GET", `${o.base}/integrations/ai-jobs/${job.id}`)).body;
  assert.equal(before.generated, 2); assert.equal(before.failed.length, 1);
  const retry = (await o.b.call("POST", `${o.base}/integrations/ai-jobs/${job.id}/retry`, {})).body;
  assert.equal(retry.generated, 2); assert.equal(retry.total, 3);
  let selected;
  try { fakeAI.chatJSON = async args => { selected = args.meta.selected_endpoints; return original(args); }; await drainJobs(); }
  finally { fakeAI.chatJSON = original; }
  assert.deepEqual(selected.map(e => e.path), ["/records/1"]);
  const done = (await o.b.call("GET", `${o.base}/integrations/ai-jobs/${job.id}`)).body;
  assert.equal(done.generated, 3); assert.equal(done.status, "complete");
  assert.deepEqual(done.integration.tools.filter(t=>t.request.path !== "/records/1"), before.integration.tools);
});
