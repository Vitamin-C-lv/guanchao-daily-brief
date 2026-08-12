import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./research-contract.mjs";
import { publishWriterResult, repositoryRoot } from "./content-publisher.mjs";

const moduleFile = fileURLToPath(import.meta.url);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) throw new Error("CLI_ARGUMENT unknown positional argument");
    const key = args[index].slice(2);
    parsed[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (typeof args.package !== "string" || typeof args.result !== "string") throw new Error("CLI_ARGUMENT --package and --result are required");
    const receipt = publishWriterResult({ packageDirectory: path.resolve(args.package), resultFile: path.resolve(args.result), root: args.root ? path.resolve(args.root) : repositoryRoot, dryRun: args["dry-run"] === true, fixtureWrite: args["fixture-write"] === true, production: args.production === true, correction: args.correction === true, maintenanceProjection: args["maintenance-projection"] === true });
    console.log(canonicalJson(receipt));
  } catch (cause) {
    console.error(`${cause?.code ?? "CONTENT_PUBLISHER_FAILURE"} ${cause?.path ?? "publisher"} ${cause instanceof Error ? cause.message : "unexpected failure"}`);
    process.exitCode = 1;
  }
}
