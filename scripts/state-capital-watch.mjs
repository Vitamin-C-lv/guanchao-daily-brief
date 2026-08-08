import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const KINDS = new Set(["official_confirmed", "reliable_report", "market_inference", "no_event_claimed"]);

export function validateStateCapitalEvent(event) {
  const errors = [];
  if (!event?.eventId) errors.push("eventId required");
  if (!Array.isArray(event?.subjectIds) && !Array.isArray(event?.scope)) errors.push("subjectIds or scope required");
  if (!KINDS.has(event?.evidenceKind)) errors.push("evidenceKind invalid");
  if (!Array.isArray(event?.relatedThreadIds)) errors.push("relatedThreadIds required");
  const text = JSON.stringify(event);
  if (/医保|医疗产业政策|支付体系/.test(text) && /国家队|state.?capital/i.test(text)) errors.push("NHSA/medical payment must not be classified as stock state capital");
  if (event?.evidenceKind === "official_confirmed" && !event?.officialUrl) errors.push("official_confirmed requires officialUrl");
  if (errors.length) throw new Error(`STATE_CAPITAL_WATCH_INVALID ${errors.join("; ")}`);
  return { valid: true, eventId: event.eventId, evidenceKind: event.evidenceKind };
}

export function validateStateCapitalRegistry(registry) {
  if (registry?.schemaVersion !== "state-capital-watch-registry-v1" || !Array.isArray(registry.subjects) || registry.subjects.length < 9) throw new Error("STATE_CAPITAL_WATCH_REGISTRY_INVALID");
  return { valid: true, subjectCount: registry.subjects.length, excludedAsStateCapital: registry.excludedAsStateCapital };
}

const sample = {
  schemaVersion: "state-capital-watch-event-v1",
  eventId: "state-capital-watch-bootstrap-20260807",
  scope: ["中央汇金", "中国证券金融", "国新投资", "诚通", "全国社保基金", "基本养老基金", "国有险资", "央企增持/回购", "宽基ETF"],
  evidenceKind: "no_event_claimed",
  officialUrl: null,
  relatedThreadIds: ["thread-state-capital-evidence"],
  status: "bootstrap",
};

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "config", "state-capital-watch-sources.json"), "utf8"));
    console.log(JSON.stringify({ registry: validateStateCapitalRegistry(registry), sample: validateStateCapitalEvent(sample) }, null, 2));
  } catch (error) {
    console.error(`STATE_CAPITAL_WATCH_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
