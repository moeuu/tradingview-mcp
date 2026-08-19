import { analyzeBars } from "./analysis.js";
import type { Bar } from "./domain.js";
import type { TradingViewDateRangeHistoryResult } from "./tradingview-browser.js";

export interface TradingViewDayContextInput {
  date: string;
  timezone: string;
  includeBars: boolean;
  lookbackBars: number;
}

export function buildTradingViewDayContext(
  history: TradingViewDateRangeHistoryResult,
  input: TradingViewDayContextInput,
) {
  const datedBars = history.bars.map((bar) => ({
    bar,
    calendarDate: calendarDateForUnixTime(bar.time, input.timezone),
  }));
  const matchingBars = datedBars
    .filter((entry) => entry.calendarDate === input.date)
    .map((entry) => entry.bar);
  const matchingExportRows = history.exportRows.filter(
    (row) => calendarDateForUnixTime(row.bar.time, input.timezone) === input.date,
  );
  const barsThroughDate = datedBars
    .filter((entry) => entry.calendarDate <= input.date)
    .map((entry) => entry.bar);
  const priorBar = [...datedBars]
    .reverse()
    .find((entry) => entry.calendarDate < input.date)?.bar;
  const nextBar = datedBars.find((entry) => entry.calendarDate > input.date)?.bar;

  const source = {
    provider: "TradingView",
    method: history.source,
    authenticated: history.authenticated,
    delayed: history.delayed,
    chartTimezone: history.chartTimezone,
    archiveFile: history.file,
    archiveBytes: history.bytes,
    exportedBarCount: history.sourceBarCount,
    retainedBarCount: history.barCount,
    requestedBars: input.lookbackBars,
    requestedBarsSatisfied: barsThroughDate.length >= input.lookbackBars,
    truncated: history.truncated,
  };

  if (matchingBars.length === 0) {
    return {
      symbol: history.symbol,
      requestedDate: input.date,
      interval: history.interval,
      timezone: input.timezone,
      status: "no_session_bar" as const,
      session: null,
      previousBar: priorBar ?? null,
      nextBar: nextBar ?? null,
      technicalAnalysis: null,
      rollingPerformance: [],
      exportedFields: [],
      source,
      note: "TradingView exported no bar assigned to the requested calendar date. This commonly indicates a non-trading day or unavailable history.",
      ...(input.includeBars ? { bars: [] as Bar[] } : {}),
    };
  }

  const session = aggregateBars(matchingBars, priorBar);
  const analysisBars = barsThroughDate.slice(-input.lookbackBars);
  const technicalAnalysis = analyzeBars(analysisBars);

  return {
    symbol: history.symbol,
    requestedDate: input.date,
    interval: history.interval,
    timezone: input.timezone,
    status: "complete" as const,
    session,
    previousBar: priorBar ?? null,
    nextBar: nextBar ?? null,
    technicalAnalysis,
    rollingPerformance: [5, 20, 50, 200].map((periods) =>
      rollingPerformance(analysisBars, periods),
    ),
    exportedFields: matchingExportRows.map((row) => ({
      time: row.bar.time,
      fields: row.fields,
    })),
    source,
    ...(input.includeBars ? { bars: matchingBars } : {}),
  };
}

export function tradingViewLookbackRange(
  date: string,
  interval: string,
  lookbackBars: number,
): { from: string; to: string } {
  const approximateDaysPerBar = intervalDays(interval);
  const calendarDays = Math.min(
    36_500,
    Math.max(10, Math.ceil(approximateDaysPerBar * lookbackBars * 1.8)),
  );
  return {
    from: addUtcDays(date, -calendarDays),
    to: interval.trim().toUpperCase().endsWith("S") ? date : addUtcDays(date, 1),
  };
}

export function calendarDateForUnixTime(time: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time * 1_000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function aggregateBars(bars: readonly Bar[], priorBar: Bar | undefined) {
  const first = bars[0]!;
  const last = bars.at(-1)!;
  const high = Math.max(...bars.map((bar) => bar.high));
  const low = Math.min(...bars.map((bar) => bar.low));
  const volumes = bars.map((bar) => bar.volume).filter((value): value is number => value !== undefined);
  const volume = volumes.length === bars.length
    ? volumes.reduce((sum, value) => sum + value, 0)
    : null;
  const previousClose = priorBar?.close ?? null;
  const closeChange = previousClose === null ? null : last.close - previousClose;
  const closeChangePercent = previousClose === null
    ? null
    : percentageChange(last.close, previousClose);
  const openGap = previousClose === null ? null : first.open - previousClose;
  const openGapPercent = previousClose === null
    ? null
    : percentageChange(first.open, previousClose);
  const openToCloseChange = last.close - first.open;

  return {
    firstBarTime: first.time,
    lastBarTime: last.time,
    barCount: bars.length,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    previousClose,
    closeChange,
    closeChangePercent,
    openGap,
    openGapPercent,
    openToCloseChange,
    openToCloseChangePercent: percentageChange(last.close, first.open),
    range: high - low,
    rangePercentOfOpen: percentageChange(high, low === high ? high : first.open, high - low),
  };
}

function rollingPerformance(bars: readonly Bar[], periods: number) {
  const latest = bars.at(-1)!;
  const comparisonIndex = bars.length - 1 - periods;
  const comparison = comparisonIndex >= 0 ? bars[comparisonIndex]! : undefined;
  const window = bars.slice(Math.max(0, bars.length - periods));
  return {
    periods,
    available: comparison !== undefined,
    change: comparison ? latest.close - comparison.close : null,
    changePercent: comparison ? percentageChange(latest.close, comparison.close) : null,
    high: window.length > 0 ? Math.max(...window.map((bar) => bar.high)) : null,
    low: window.length > 0 ? Math.min(...window.map((bar) => bar.low)) : null,
    averageVolume: averageDefined(window.map((bar) => bar.volume)),
  };
}

function percentageChange(
  current: number,
  base: number,
  explicitDifference = current - base,
): number | null {
  return Math.abs(base) <= Number.EPSILON ? null : (explicitDifference / Math.abs(base)) * 100;
}

function averageDefined(values: readonly (number | undefined)[]): number | null {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0
    ? null
    : defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

function intervalDays(interval: string): number {
  const normalized = interval.trim().toUpperCase();
  if (normalized === "D") return 2;
  if (normalized === "W") return 10;
  if (normalized === "M") return 45;
  const match = /^(\d+)([STHDWM]?)$/.exec(normalized);
  if (!match) return 2;
  const count = Number(match[1]);
  switch (match[2]) {
    case "S": return Math.max(1 / 86_400, count / 86_400);
    case "H": return count / 8;
    case "D": return count * 2;
    case "W": return count * 10;
    case "M": return count * 45;
    default: return count / 360;
  }
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
