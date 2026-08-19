import { describe, expect, it } from "vitest";
import type { Bar } from "../src/domain.js";
import type { TradingViewDateRangeHistoryResult } from "../src/tradingview-browser.js";
import {
  buildTradingViewDayContext,
  calendarDateForUnixTime,
  tradingViewLookbackRange,
} from "../src/tradingview-day.js";

const BARS: Bar[] = [
  { time: Date.parse("2024-01-02T14:30:00Z") / 1_000, open: 100, high: 105, low: 99, close: 104, volume: 1_000 },
  { time: Date.parse("2024-01-03T14:30:00Z") / 1_000, open: 106, high: 110, low: 105, close: 108, volume: 1_200 },
  { time: Date.parse("2024-01-03T15:30:00Z") / 1_000, open: 108, high: 112, low: 107, close: 111, volume: 800 },
  { time: Date.parse("2024-01-04T14:30:00Z") / 1_000, open: 110, high: 113, low: 109, close: 112, volume: 900 },
];

function history(bars: Bar[] = BARS): TradingViewDateRangeHistoryResult {
  return {
    symbol: "NASDAQ:AAPL",
    interval: "60",
    source: "TradingView Supercharts chart-data export",
    authenticated: true,
    delayed: false,
    requestedBars: 500,
    requestedBarsSatisfied: false,
    barCount: bars.length,
    sourceBarCount: bars.length,
    truncated: false,
    file: "tradingview-exports/NASDAQ-AAPL-60.csv",
    bytes: 512,
    firstBar: bars[0]!,
    lastBar: bars.at(-1)!,
    bars,
    requestedRange: { from: "2023-01-01", to: "2024-01-04" },
    chartTimezone: "14:30:00 UTC",
    exportRows: bars.map((bar) => ({ bar, fields: { rsi: 50 } })),
  };
}

describe("TradingView day context", () => {
  it("aggregates every intraday bar and reports comparisons without hiding provenance", () => {
    const result = buildTradingViewDayContext(history(), {
      date: "2024-01-03",
      timezone: "America/New_York",
      includeBars: true,
      lookbackBars: 500,
    });

    expect(result).toMatchObject({
      symbol: "NASDAQ:AAPL",
      requestedDate: "2024-01-03",
      status: "complete",
      session: {
        barCount: 2,
        open: 106,
        high: 112,
        low: 105,
        close: 111,
        volume: 2_000,
        previousClose: 104,
        closeChange: 7,
        openGap: 2,
        openToCloseChange: 5,
      },
      previousBar: BARS[0],
      nextBar: BARS[3],
      source: {
        provider: "TradingView",
        method: "TradingView Supercharts chart-data export",
        authenticated: true,
        requestedBars: 500,
        requestedBarsSatisfied: false,
      },
      exportedFields: [
        { time: BARS[1]!.time, fields: { rsi: 50 } },
        { time: BARS[2]!.time, fields: { rsi: 50 } },
      ],
    });
    expect(result.bars).toEqual(BARS.slice(1, 3));
    expect(result.technicalAnalysis).toMatchObject({ barsAnalyzed: 3, asOf: BARS[2]!.time });
    expect(result.rollingPerformance).toHaveLength(4);
  });

  it("returns an explicit no-session result instead of silently choosing another date", () => {
    const result = buildTradingViewDayContext(history(), {
      date: "2024-01-06",
      timezone: "UTC",
      includeBars: false,
      lookbackBars: 500,
    });

    expect(result).toMatchObject({
      status: "no_session_bar",
      session: null,
      technicalAnalysis: null,
      previousBar: BARS[3],
    });
    expect(result).not.toHaveProperty("bars");
  });

  it("handles timezone date boundaries and bounded lookback ranges", () => {
    const time = Date.parse("2024-01-03T01:00:00Z") / 1_000;
    expect(calendarDateForUnixTime(time, "UTC")).toBe("2024-01-03");
    expect(calendarDateForUnixTime(time, "America/New_York")).toBe("2024-01-02");
    expect(tradingViewLookbackRange("2024-01-03", "D", 500)).toEqual({
      from: "2019-01-29",
      to: "2024-01-04",
    });
    expect(tradingViewLookbackRange("2024-01-03", "30S", 500)).toEqual({
      from: "2023-12-24",
      to: "2024-01-03",
    });
  });
});
