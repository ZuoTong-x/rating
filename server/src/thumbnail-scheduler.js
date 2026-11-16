const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function localHourAt(date, timeZone = DEFAULT_TIME_ZONE) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || DEFAULT_TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    return Number.parseInt(parts.find((part) => part.type === "hour")?.value || "0", 10);
  } catch {
    return localHourAt(date, DEFAULT_TIME_ZONE);
  }
}

export function hourInWindow(hour, startHour, endHour) {
  const hourValue = boundedInteger(hour, 0, 0, 23);
  const start = boundedInteger(startHour, 22, 0, 23);
  const end = boundedInteger(endHour, 8, 0, 23);
  if (start === end) return false;
  if (start < end) return hourValue >= start && hourValue < end;
  return hourValue >= start || hourValue < end;
}

export function resolveThumbnailSchedule(settings = {}, date = new Date()) {
  const timeZone = String(settings.timeZone || DEFAULT_TIME_ZONE);
  const localHour = localHourAt(date, timeZone);
  const nightStartHour = boundedInteger(settings.nightStartHour, 22, 0, 23);
  const nightEndHour = boundedInteger(settings.nightEndHour, 8, 0, 23);
  const isNight = hourInWindow(localHour, nightStartHour, nightEndHour);
  const daytimeConcurrency = boundedInteger(settings.daytimeConcurrency, 2, 1, 16);
  const nighttimeConcurrency = boundedInteger(settings.nighttimeConcurrency, 6, 1, 16);
  return {
    globallyPaused: Boolean(settings.globallyPaused),
    timeZone,
    localHour,
    isNight,
    period: isNight ? "night" : "day",
    concurrency: isNight ? nighttimeConcurrency : daytimeConcurrency,
  };
}
