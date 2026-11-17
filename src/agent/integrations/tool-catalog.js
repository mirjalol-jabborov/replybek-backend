// Large integrations expose a paged catalog instead of sending hundreds of JSON schemas
// to the answer model. Execution still uses the exact same validation and confirmations.
export function toolInterface(entries, execute) {
  const definitions = entries.map(({tool}) => ({name:tool.name,description:tool.when?`${tool.description}\nWhen to use: ${tool.when}`:tool.description,parameters:tool.modelInput || tool.input || {type:"object",properties:{}}}));
  if(definitions.length<=40)return {tools:definitions,run:execute,maxSteps:4};
  const names=new Map(definitions.map(t=>[t.name,t]));
  return {
    maxSteps:8,
    tools:[
      {name:"__replybek_find_actions",description:"Search available business actions by name or purpose. Translate search terms if needed. Empty query browses the catalog. Inspect a matching action schema before executing it.",parameters:{type:"object",properties:{query:{type:"string"},page:{type:"integer",minimum:0}},additionalProperties:false}},
      {name:"__replybek_describe_action",description:"Get the exact input schema for an available action. Use this before executing; do not invent arguments.",parameters:{type:"object",properties:{name:{type:"string"}},required:["name"],additionalProperties:false}},
      {name:"__replybek_execute_action",description:"Execute a previously inspected business action. All normal permissions and customer confirmations apply.",parameters:{type:"object",properties:{name:{type:"string"},args:{type:"object",additionalProperties:true}},required:["name","args"],additionalProperties:false}},
    ],
    run:async(name,args={})=>{
      if(name==="__replybek_find_actions"){
        const terms=String(args.query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0,10);
        const ranked=definitions.map(t=>({t,score:terms.reduce((n,q)=>n+Number(`${t.name} ${t.description}`.toLowerCase().includes(q)),0)})).filter(x=>!terms.length||x.score).sort((a,b)=>b.score-a.score);
        const page=Math.max(0,Math.min(100,Number.isInteger(args.page)?args.page:0)),start=page*20;
        return {total:ranked.length,page,next_page:start+20<ranked.length?page+1:null,actions:ranked.slice(start,start+20).map(({t})=>({name:t.name,description:t.description.slice(0,400)}))};
      }
      if(name==="__replybek_describe_action")return names.get(args.name) || {error:"unknown_tool"};
      if(name==="__replybek_execute_action")return names.has(args.name)?execute(args.name,args.args || {}):{error:"unknown_tool"};
      // Keeps deterministic test calls and explicitly named, permitted actions compatible.
      return names.has(name)?execute(name,args):{error:"unknown_tool"};
    },
  };
}
