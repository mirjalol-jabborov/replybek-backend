import { fail, safeKey, actionName } from "./definitions.js";
import { sensitive, redact } from "./package.js";

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
export function importCurl(input) {
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
