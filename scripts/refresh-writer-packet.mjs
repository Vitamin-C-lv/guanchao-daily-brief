#!/usr/bin/env node
/**
 * Refresh the official market evidence and generate the current writer packet for an
 * edition, then validate the packet and report its ID and market dates.
 *
 * editionDate is the Asia/Shanghai run date. The A-share as-of is the latest complete
 * trading day at or before editionDate according to the frozen CN market calendar;
 * non-trading days are never written as trading days.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePacket } from "./validate-writer-packet.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_CLOSED = new Set([0, 6]); // Sunday, Saturday

export class RefreshWriterPacketError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RefreshWriterPacketError";
    this.code = code;
  }
}

export function shanghaiCalendarDate(value = new Date()) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new RefreshWriterPacketError("FRESHNESS", `invalid time: ${String(value)}`);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function latestATradingDay(editionDate, root = repositoryRoot, now = new Date()) {
  if (!DATE.test(editionDate)) throw new RefreshWriterPacketError("FRESHNESS", `edition date must be YYYY-MM-DD: ${editionDate}`);
  const calendarFile = path.join(root, "models", "sector-rotation", "cn-market-calendar-2026.json");
  let closed = new Set();
  if (fs.existsSync(calendarFile)) {
    try {
      const calendar = JSON.parse(fs.readFileSync(calendarFile, "utf8"));
      closed = new Set(calendar.closedWeekdays ?? []);
    } catch {
      closed = new Set();
    }
  }
  const isTradingDay = (candidate) => {
    const iso = candidate.toISOString().slice(0, 10);
    const weekday = candidate.getUTCDay();
    if (!WEEKDAY_CLOSED.has(weekday) && !closed.has(iso)) return iso;
    return null;
  };
  const candidate = new Date(`${editionDate}T00:00:00.000Z`);
  let trading = null;
  while (candidate.getUTCFullYear() >= 2020) {
    trading = isTradingDay(candidate);
    if (trading) break;
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  if (!trading) throw new RefreshWriterPacketError("FRESHNESS", `no trading day found at or before ${editionDate}`);
  // A session is only complete after the Asia/Shanghai close (15:00). Before the close the
  // latest complete trading day is the previous trading day.
  if (trading === editionDate) {
    const shanghai = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    const [hour, minute] = shanghai.split(":").map(Number);
    if (hour * 60 + minute < 15 * 60) {
      const previous = new Date(`${editionDate}T00:00:00.000Z`);
      previous.setUTCDate(previous.getUTCDate() - 1);
      while (previous.getUTCFullYear() >= 2020) {
        trading = isTradingDay(previous);
        if (trading) break;
        previous.setUTCDate(previous.getUTCDate() - 1);
      }
    }
  }
  return trading;
}

export function refreshWriterPacket({
  edition = "daily",
  editionDate = null,
  runner = "scripts/run-market-evidence.mjs",
  root = repositoryRoot,
  asOf = null
} = {}) {
  if (!["daily", "weekly"].includes(edition)) throw new RefreshWriterPacketError("EDITION", `edition must be daily or weekly: ${edition}`);
  const effectiveEditionDate = editionDate ?? shanghaiCalendarDate();
  const effectiveAsOf = asOf ?? latestATradingDay(effectiveEditionDate, root);
  const runnerFile = path.resolve(root, ...runner.split("/"));
  if (!fs.existsSync(runnerFile)) throw new RefreshWriterPacketError("RUNNER", `market evidence runner is missing: ${runnerFile}`);
  const result = spawnSync(process.execPath, [runnerFile, "run", "--edition", edition, "--as-of", effectiveAsOf], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15 * 60_000
  });
  if (result.error || result.status !== 0) {
    throw new RefreshWriterPacketError("MARKET_DATA_REFRESH_FAILED", `${runnerFile} run failed: ${(result.stderr || result.stdout || result.error?.message || "unknown").trim().slice(0, 1200)}`);
  }
  const packetFile = path.join(root, "content", "writer-packets", `${edition}-latest.json`);
  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(packetFile, "utf8"));
  } catch {
    throw new RefreshWriterPacketError("PACKET_MISSING", `packet was not written: ${packetFile}`);
  }
  validatePacket(packet, packetFile);
  return {
    schemaVersion: "writer-packet-refresh-summary-v1",
    edition,
    editionDate: effectiveEditionDate,
    asOf: effectiveAsOf,
    writerPacketId: packet.writerPacketId,
    generatedAt: packet.generatedAt,
    marketDates: packet.marketDates,
    providerHealth: packet.providerHealth?.status ?? null,
    validation: "passed"
  };
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) throw new RefreshWriterPacketError("CLI_ARGUMENT", `unknown positional argument: ${values[index]}`);
    const key = values[index].slice(2);
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const summary = refreshWriterPacket({
      edition: args.edition ?? "daily",
      editionDate: args["edition-date"] ?? null,
      runner: args.runner ?? "scripts/run-market-evidence.mjs",
      root: args.root ? path.resolve(args.root) : repositoryRoot,
      asOf: args["as-of"] ?? null
    });
    console.log(JSON.stringify(summary, null, 2));
  } catch (cause) {
    console.error(cause instanceof RefreshWriterPacketError ? `${cause.code} ${cause.message}` : `REFRESH_WRITER_PACKET_FAILURE ${cause instanceof Error ? cause.message : "unexpected"}`);
    process.exitCode = 1;
  }
}
