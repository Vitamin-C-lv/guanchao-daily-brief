import { readFileSync } from "node:fs";
import path from "node:path";
import type { WeeklyReport, WeeklyReportIndex } from "@/lib/types";

const weeklyDirectory = path.join(process.cwd(), "content", "weekly-reports");
const reportIdPattern = /^weekly-\d{4}-W\d{2}$/;

export function loadWeeklyIndex(): WeeklyReportIndex {
  const raw = readFileSync(path.join(weeklyDirectory, "index.json"), "utf8");
  return JSON.parse(raw) as WeeklyReportIndex;
}

export function loadWeeklyReport(id: string): WeeklyReport | undefined {
  if (!reportIdPattern.test(id)) return undefined;
  const index = loadWeeklyIndex();
  if (!index.reports.some((entry) => entry.id === id)) return undefined;
  try {
    const raw = readFileSync(path.join(weeklyDirectory, `${id}.json`), "utf8");
    return JSON.parse(raw) as WeeklyReport;
  } catch {
    return undefined;
  }
}

export function loadLatestWeeklyReport(): WeeklyReport | undefined {
  const index = loadWeeklyIndex();
  return index.latestReportId ? loadWeeklyReport(index.latestReportId) : undefined;
}
