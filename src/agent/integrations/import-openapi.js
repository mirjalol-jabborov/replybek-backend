import { fail, safeKey, actionName } from "./definitions.js";
import { sensitive } from "./package.js";

export function importOpenAPI(doc) {
  if (!/^3\./.test(doc.openapi || "")) fail("Use an OpenAPI 3.x document.");
  const warnings = [
    "Imported actions are drafts. Review inputs, authentication and read/write classification.",
  ];
  function ref(value, trail = []) {
    if (!value?.$ref) return value;
    const path = value.$ref;
    if (!path.startsWith("#/"))
      fail("Bundle external references into this document before importing.");
    if (trail.includes(path) || trail.length > 15)
      fail("Recursive references are not supported by the importer.");
    const found = path
      .slice(2)
      .split("/")
      .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((o, k) => (safeKey(k) ? o?.[k] : undefined), doc);
    if (!found) fail(`Unresolved reference: ${path}`);
    return ref(found, [...trail, path]);
  }
  function schema(raw, depth = 0) {
    if (depth > 15) fail("Input schema is too deeply nested.");
    const s = ref(raw) || {};
    if (s.oneOf || s.anyOf || s.allOf)
      fail("Flatten oneOf, anyOf and allOf input schemas before importing.");
    const out = {};
    for (const k of [
      "type",
      "description",
      "enum",
      "required",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "pattern",
      "minItems",
      "maxItems",
      "additionalProperties",
    ])
      if (s[k] !== undefined) out[k] = s[k];
    if (s.properties)
      out.properties = Object.fromEntries(
        Object.entries(s.properties)
          .filter(([k]) => safeKey(k))
          .map(([k, v]) => [k, schema(v, depth + 1)]),
      );
    if (s.items) out.items = schema(s.items, depth + 1);
    if (!out.type) out.type = s.properties ? "object" : "string";
    return out;
  }
  let base = doc.servers?.[0]?.url || "";
  for (const [key, v] of Object.entries(doc.servers?.[0]?.variables || {}))
    base = base.replaceAll(`{${key}}`, v.default || "");
  if (base && !/^https?:\/\//.test(base)) {
    base = "";
    warnings.push(
      "Enter your API base address; the specification uses a relative server URL.",
    );
  }
  const tools = [],
    names = new Set();
  for (const [path, rawItem] of Object.entries(doc.paths || {})) {
    const item = ref(rawItem);
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item[method];
      if (!op) continue;
      if (op.servers || item.servers)
        fail(
          "Operations with different servers must be imported as separate integrations.",
        );
      const props = {},
        required = [],
        headers = {},
        query = [];
      let endpoint = path;
      const params = new Map(
        [...(item.parameters || []), ...(op.parameters || [])].map((p) => {
          const v = ref(p);
          return [`${v.in}:${v.name}`, v];
        }),
      );
      for (const p of params.values()) {
        if (p.in === "cookie" || sensitive.test(p.name)) {
          warnings.push(`Configure authentication separately for ${p.name}.`);
          continue;
        }
        if (!["path", "query", "header"].includes(p.in))
          fail(`Unsupported parameter location: ${p.in}`);
        if (!/^[a-z][a-z0-9_]*$/i.test(p.name) || props[p.name])
          fail(`Rename duplicate or unsupported input name: ${p.name}`);
        const s = schema(p.schema);
        if (["array", "object"].includes(s.type))
          fail(`Use scalar path/query/header parameter ${p.name}.`);
        props[p.name] = {
          ...s,
          description: p.description || s.description || p.name,
        };
        if (p.required) required.push(p.name);
        const template = `{{args.${p.name}${p.in === "header" ? "" : " | url"}}}`;
        if (p.in === "path")
          endpoint = endpoint.replace(`{${p.name}}`, template);
        if (p.in === "query")
          query.push(`${encodeURIComponent(p.name)}=${template}`);
        if (p.in === "header") headers[p.name] = template;
      }
      let body;
      if (op.requestBody) {
        const rb = ref(op.requestBody);
        const json = rb.content?.["application/json"];
        if (!json)
          fail(
            `Only JSON request bodies are supported (${method.toUpperCase()} ${path}).`,
          );
        props.body = schema(json.schema);
        if (rb.required) required.push("body");
        body = "{{args.body}}";
      }
      let name = actionName(op.operationId || method + "_" + path);
      let n = 1;
      const stem = name.slice(0, 42);
      while (names.has(name)) name = `${stem}_${n++}`;
      names.add(name);
      tools.push({
        name,
        description: (
          op.summary ||
          op.description ||
          `${method.toUpperCase()} ${path}`
        ).slice(0, 600),
        kind: method === "get" ? "read" : "write",
        input: { type: "object", properties: props, required },
        request: {
          method: method.toUpperCase(),
          path: endpoint + (query.length ? "?" + query.join("&") : ""),
          headers,
          ...(body ? { body } : {}),
        },
        response: { type: "json" },
      });
    }
  }
  if (!tools.length) fail("No supported operations found.");
  if (tools.length > 500)
    fail("Import a specification containing at most 500 operations.");
  return {
    integration: {
      name: doc.info?.title?.slice(0, 80) || "Imported API",
      mode: "server",
      base_url: base,
      auth: { type: "oauth" },
      tools,
    },
    warnings,
  };
}
