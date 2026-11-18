import { safeKey } from "./definitions.js";

export const sensitive =
  /authorization|cookie|password|secret|token|api[-_]?key|credential/i;
export function redact(value, key = "") {
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
