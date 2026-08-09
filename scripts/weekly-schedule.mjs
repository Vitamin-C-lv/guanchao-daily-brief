const SHANGHAI = "Asia/Shanghai";

function dateAtNoon(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error(`invalid date: ${dateText}`);
  return new Date(`${dateText}T12:00:00+08:00`);
}

export function isSaturdayWeekly(weekEnd) {
  return dateAtNoon(weekEnd).getUTCDay() === 6;
}

export function weeklyRunGuard(editionDate) {
  const weekday = dateAtNoon(editionDate).getUTCDay();
  if (weekday === 0) return { allowed: false, reason: "SUNDAY_NO_REPORT" };
  return { allowed: weekday === 6, reason: weekday === 6 ? null : "WEEKLY_SCHEDULE_SATURDAY_ONLY" };
}

export function shouldIncludeDailyEdition({ weekStart, weekEnd, editionDate }) {
  if (editionDate < weekStart || editionDate > weekEnd) return false;
  return !(isSaturdayWeekly(weekEnd) && editionDate === weekEnd);
}

export function isUsFridayCloseAllowed({ weekEnd, sessionEnd }) {
  return isSaturdayWeekly(weekEnd) && sessionEnd === weekEnd;
}
