import Ajv from "ajv";
import YAML from "yaml";
import { HttpError } from "./http.js";
import { pick } from "./template.js";
import { integrationSchema } from "../validators.js";

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const fail = (message) => {
  throw new HttpError(400, message);
};
const safeKey = (key) =>
  !["__proto__", "prototype", "constructor"].includes(key);
export function modelInput(tool) {
  const input = tool.input || { type: "object", properties: {} };
  const properties = Object.fromEntries(
    Object.entries(input.properties || {}).filter(
      ([key]) =>
        !tool.bindings?.[key] || tool.bindings[key].source === "customer",
    ),
  );
  return {
    ...input,
    properties,
    required: (input.required || []).filter((key) => key in properties),
    additionalProperties: false,
  };
}
export function resolveInputs(tool, supplied = {}, context = {}, steps = {}) {
  const args = Object.fromEntries(
    Object.entries(supplied).filter(([k]) => safeKey(k)),
  );
  for (const [key, binding] of Object.entries(tool.bindings || {})) {
    if (!safeKey(key)) fail("Reserved input name.");
    if (binding.source === "fixed") args[key] = binding.value;
    if (binding.source === "context") args[key] = pick(context, binding.path);
    if (binding.source === "step") args[key] = pick(steps, binding.path);
  }
  let validate;
  try {
    validate = ajv.compile(tool.input || { type: "object", properties: {} });
  } catch {
    fail("Invalid action input schema.");
  }
  if (!validate(args))
    fail(
      `Check action inputs: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
    );
  return args;
}
export function validateDefinitions(config) {
  const names = new Set();
  const tools = config.tools || [];
  for (const tool of [...tools, ...(config.procedures || [])]) {
    if (names.has(tool.name))
      fail(`Duplicate action or procedure name: ${tool.name}`);
    names.add(tool.name);
    try {
      ajv.compile(tool.input);
    } catch {
      fail(`Invalid input schema for ${tool.name}.`);
    }
    for (const [key, binding] of Object.entries(tool.bindings || {})) {
      if (!safeKey(key) || !(key in (tool.input.properties || {})))
        fail(`Binding ${key} must match a declared input.`);
      if (["context", "step"].includes(binding.source) && !binding.path)
        fail(`Choose the source field for ${key}.`);
    }
    if (tool.request?.allow) {
      try {
        new RegExp(tool.request.allow);
      } catch {
        fail(`Invalid allowed-path expression for ${tool.name}.`);
      }
    }
  }
  for (const procedure of config.procedures || []) {
    const ids = new Set();
    for (const step of procedure.steps) {
      if (ids.has(step.id)) fail(`Duplicate step name: ${step.id}`);
      if (step.kind === "action" && !tools.some((t) => t.name === step.tool))
        fail(`Unknown action ${step.tool} in ${procedure.name}.`);
      for (const match of JSON.stringify(step).matchAll(
        /steps\.([a-z][a-z0-9_]*)/g,
      )) {
        if (!ids.has(match[1]))
          fail(`Step ${step.id} must reference an earlier step (${match[1]}).`);
      }
      if (step.kind === "action")
        for (const binding of Object.values(
          tools.find((t) => t.name === step.tool)?.bindings || {},
        ))
          if (
            binding.source === "step" &&
            !ids.has(binding.path?.split(".")[0])
          )
            fail(
              `Step ${step.id} uses an unavailable earlier result (${binding.path}).`,
            );
      ids.add(step.id);
    }
  }
}

const sensitive =
  /authorization|cookie|password|secret|token|api[-_]?key|credential/i;
function redact(value, key = "") {
  if (sensitive.test(key) && typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => safeKey(k))
        .map(([k, v]) => {
          if (k === "headers")
            return [
              k,
              Object.fromEntries(
                Object.entries(v || {}).map(([h, x]) => [
                  h,
                  /^(accept|content-type)$/i.test(h) ||
                  /^\{\{context\.[a-z0-9_]+\}\}$/i.test(x)
                    ? x
                    : "",
                ]),
              ),
            ];
          if (k === "bindings")
            return [
              k,
              Object.fromEntries(
                Object.entries(v || {}).map(([n, b]) => [
                  n,
                  b.source === "fixed" ? { source: "fixed", value: null } : redact(b),
                ]),
              ),
            ];
          return [k, redact(v, k)];
        }),
    );
  }
  if (typeof value === "string" && /^https?:/i.test(value)) {
    try {
      const u = new URL(value);
      u.username = "";
      u.password = "";
      for (const k of [...u.searchParams.keys()])
        if (sensitive.test(k)) u.searchParams.delete(k);
      return u.toString().replace(/\/$/, "");
    } catch {
      return "";
    }
  }
  if (typeof value === "string" && key === "path")
    return value.replace(
      /([?&](?:[^=&]*(?:token|key|secret|password)[^=&]*)=)[^&]*/gi,
      "$1",
    );
  return value;
}
export function exportPackage(integration) {
  const { name, mode, base_url, headers, context, account, tools, procedures } =
    integration;
  // Connection credentials, client identity, test results and customer sessions never travel.
  const auth = Object.fromEntries(
    [
      "type",
      "authorize_url",
      "token_url",
      "scope",
      "token_format",
      "header",
      "prefix",
    ]
      .filter((k) => integration.auth?.[k] !== undefined)
      .map((k) => [k, redact(integration.auth[k], /_url$/.test(k) ? "path" : "")]),
  );
  auth.type ||= "oauth";
  return {
    format: "replybek.integration",
    version: 1,
    integration: {
      ...redact({
        name,
        mode,
        base_url,
        headers,
        context,
        account,
        tools,
        procedures: procedures || [],
        enabled: false,
      }),
      auth,
    },
  };
}

function shellWords(input) {
  const words = [];
  let word = "",
    quote = "",
    active = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (
        c === "\\" &&
        quote === '"' &&
        ['"', "\\"].includes(input[i + 1])
      )
        word += input[++i];
      else word += c;
      active = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      active = true;
    } else if (c === "\\") {
      if (input[i + 1] === "\n") i++;
      else {
        word += input[++i] || "";
        active = true;
      }
    } else if (/\s/.test(c)) {
      if (active) words.push(word);
      word = "";
      active = false;
    } else {
      word += c;
      active = true;
    }
  }
  if (quote) fail("Close the quoted string in your cURL request.");
  if (active) words.push(word);
  return words;
}
const actionName = (s) =>
  ("action_" + s)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 48);
function importCurl(input) {
  const words = shellWords(input);
  if (words.shift() !== "curl")
    fail("Paste a cURL command starting with curl.");
  let url, method, body;
  const headers = {},
    warnings = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = () => {
      if (words[i + 1] === undefined) fail(`Missing value after ${w}.`);
      return words[++i];
    };
    if (w === "-X" || w === "--request") method = next().toUpperCase();
    else if (w === "-H" || w === "--header") {
      const h = next();
      const at = h.indexOf(":");
      if (at < 1) fail("Headers need a name and value.");
      headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
    } else if (
      ["-d", "--data", "--data-raw", "--data-binary", "--json"].includes(w)
    ) {
      const raw = next();
      if (raw.startsWith("@"))
        fail("Paste the JSON body directly; file references are not imported.");
      try {
        body = JSON.parse(raw);
      } catch {
        fail("Only JSON request bodies are supported by this importer.");
      }
    } else if (w === "--url") url = next();
    else if (
      [
        "--compressed",
        "--silent",
        "-s",
        "--show-error",
        "-S",
        "--location",
        "-L",
      ].includes(w)
    ) {
      if (["-L", "--location"].includes(w))
        warnings.push("Redirects will not be followed.");
    } else if (["-u", "--user", "-b", "--cookie"].includes(w)) {
      next();
      warnings.push(
        "Credentials were removed. Configure authentication separately.",
      );
    } else if (w.startsWith("-"))
      fail(`Unsupported cURL option: ${w}. Import a single JSON HTTP request.`);
    else if (/^https?:\/\//.test(w) && !url) url = w;
    else
      fail(
        "Import one request only. Shell expressions and pipelines are not executed.",
      );
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    fail("Add a full http(s) URL to the cURL request.");
  }
  if (!["http:", "https:"].includes(u.protocol))
    fail("Only HTTP requests are supported.");
  method ||= body === undefined ? "GET" : "POST";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    fail("Unsupported HTTP method.");
  u.username = "";
  u.password = "";
  const properties = {},
    required = [],
    bindings = {};
  for (const [k, v] of [...u.searchParams]) {
    if (sensitive.test(k)) {
      u.searchParams.delete(k);
      warnings.push("A credential was removed from the URL.");
      continue;
    }
    if (!/^[a-z][a-z0-9_]*$/i.test(k)) continue;
    properties[k] = { type: "string", description: k };
    required.push(k);
    u.searchParams.set(k, `{{args.${k} | url}}`);
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    body = Object.fromEntries(
      Object.entries(body)
        .filter(([k]) => safeKey(k))
        .map(([k, v]) => {
          if (sensitive.test(k)) {
            warnings.push(`Removed credential field ${k}.`);
            return [k, ""];
          }
          if (k in properties)
            fail(
              `Input name ${k} appears in both query and body. Rename it before import.`,
            );
          properties[k] = {
            type: Array.isArray(v) ? "array" : v === null ? "string" : typeof v,
            description: k,
          };
          return [k, `{{args.${k}}}`];
        }),
    );
  }
  const path =
    u.pathname +
    u.search
      .replace(/%7B/gi, "{")
      .replace(/%7D/gi, "}")
      .replace(/%7C/gi, "|")
      .replace(/\+/g, " ");
  const safeHeaders = redact({ headers }).headers;
  if (JSON.stringify(headers) !== JSON.stringify(safeHeaders))
    warnings.push(
      "Header credentials and custom literal header values were removed. Review headers.",
    );
  return {
    integration: {
      name: u.hostname,
      mode: "server",
      base_url: u.origin,
      auth: { type: "oauth" },
      tools: [
        {
          name: actionName(method + "_" + u.pathname),
          description: `${method} ${u.pathname}`,
          kind: method === "GET" ? "read" : "write",
          input: { type: "object", properties, required },
          bindings,
          request: {
            method,
            path,
            headers: safeHeaders,
            ...(body === undefined ? {} : { body }),
          },
          response: { type: "json" },
        },
      ],
    },
    warnings,
  };
}
function importOpenAPI(doc) {
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
export function importDefinition(format, source) {
  if (format === "curl") return importCurl(source);
  let doc;
  try {
    doc = YAML.parse(source, { maxAliasCount: 20 });
  } catch (e) {
    fail("Invalid JSON or YAML document.");
  }
  if (!doc || typeof doc !== "object") fail("Paste a configuration document.");
  if (format === "package") {
    if (
      doc.format !== "replybek.integration" ||
      doc.version !== 1 ||
      !doc.integration
    )
      fail("Use a Replybek integration package, version 1.");
    const parsed = integrationSchema
      .innerType()
      .omit({ agent_id: true })
      .safeParse(exportPackage(doc.integration).integration);
    if (!parsed.success)
      fail(
        "This package has invalid configuration fields. Export a valid integration and try again.",
      );
    const clean = parsed.data;
    validateDefinitions(clean);
    return {
      integration: clean,
      warnings: [
        "Stored credentials and fixed input values were removed. Re-enter them before enabling.",
      ],
    };
  }
  return importOpenAPI(doc);
}
