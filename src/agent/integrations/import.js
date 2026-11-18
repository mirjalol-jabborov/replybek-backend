import YAML from "yaml";
import { fail, validateDefinitions } from "./definitions.js";
import { integrationSchema } from "./checks.js";
import { exportPackage } from "./package.js";
import { importCurl } from "./import-curl.js";
import { importOpenAPI } from "./import-openapi.js";

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
