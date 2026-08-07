import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AUTHORITY = new Set(["central", "ministry", "exchange", "hong-kong", "registry"]);
const STAGE = new Set(["not_applicable", "meeting_statement", "draft", "published", "effective", "implemented", "under_implementation", "suspended", "unknown"]);

export function validatePolicyWatchEvent(event, { registry = null } = {}) {
  const errors = [];
  if (!event || typeof event !== "object") errors.push("event must be object");
  if (!event?.eventId) errors.push("eventId required");
  if (!event?.issuer) errors.push("issuer required");
  if (!AUTHORITY.has(event?.authorityLevel)) errors.push("authorityLevel invalid");
  if (!event?.documentType) errors.push("documentType required");
  if (!DATE.test(String(event?.publishedAt ?? "").slice(0, 10))) errors.push("publishedAt invalid");
  if (event?.effectiveAt !== null && event?.effectiveAt !== undefined && !DATE.test(String(event.effectiveAt).slice(0, 10))) errors.push("effectiveAt invalid");
  if (!STAGE.has(event?.implementationStage)) errors.push("implementationStage invalid");
  if (event?.officialUrl !== null && event?.officialUrl !== undefined && !String(event.officialUrl).startsWith("https://") && !String(event.officialUrl).startsWith("http://")) errors.push("officialUrl invalid");
  if (!Array.isArray(event?.relatedThreadIds)) errors.push("relatedThreadIds required");
  if (event?.documentType === "meeting_statement" && ["effective", "implemented"].includes(event?.implementationStage)) errors.push("meeting statement cannot be recorded as effective/implemented without a formal document");
  if (registry && !registry.issuers.some((issuer) => issuer.name === event.issuer || issuer.issuerId === event.issuer)) errors.push("issuer absent from official registry");
  if (errors.length) throw new Error(`POLICY_WATCH_INVALID ${errors.join("; ")}`);
  return { valid: true, eventId: event.eventId, issuer: event.issuer, implementationStage: event.implementationStage };
}

export function validatePolicyRegistry(registry) {
  if (registry?.schemaVersion !== "policy-watch-registry-v1" || !Array.isArray(registry.issuers) || registry.issuers.length < 23) throw new Error("POLICY_WATCH_REGISTRY_INVALID");
  return { valid: true, issuerCount: registry.issuers.length };
}

const sample = {
  schemaVersion: "policy-watch-event-v1",
  eventId: "policy-watch-bootstrap-20260807",
  issuer: "registry",
  authorityLevel: "registry",
  documentType: "registry",
  publishedAt: "2026-08-07",
  effectiveAt: null,
  implementationStage: "not_applicable",
  officialUrl: null,
  relatedThreadIds: ["thread-policy-watch-official-stage"],
  evidenceStatus: "no_event_claimed",
  status: "bootstrap",
};

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "config", "policy-watch-sources.json"), "utf8"));
    console.log(JSON.stringify({ registry: validatePolicyRegistry(registry), sample: validatePolicyWatchEvent(sample, { registry }) }, null, 2));
  } catch (error) {
    console.error(`POLICY_WATCH_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
