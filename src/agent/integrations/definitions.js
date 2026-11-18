import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import { HttpError } from "../../core/http.js";
import { pick } from "./template.js";

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
export const fail = (message) => {
  throw new HttpError(400, message);
};
export const safeKey = (key) =>
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
  for (const tool of tools) {
    const action = tool.display?.action;
    // The action may live in another of the agent's integrations; one here must be a write action.
    const here = action && tools.find((t) => t.name === action.tool);
    if (here && here.kind !== "write") fail(`The card button on ${tool.name} must run a write action.`);
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

export const actionName = (s) =>
  ("action_" + s)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 48);

export function sameAction(a, b) {
  if (!a || !b) return false;
  const { modelInput: _a, ...left } = a; const { modelInput: _b, ...right } = b;
  return isDeepStrictEqual(left, right);
}
