import { describe, expect, it, vi } from "vitest";
import type {
  TradingViewDateRangeHistoryResult,
  TradingViewHistoryResult,
} from "../src/tradingview-browser.js";
import {
  analyzeTradingViewSymbolForMcp,
  captureTradingViewPeriodForMcp,
  getTradingViewDayForMcp,
  getTradingViewHistoryForMcp,
  TradingViewAnalyzeInputSchema,
  TradingViewMcpHistoryInputSchema,
} from "../src/tools.js";
import {
  TradingViewDayInputSchema,
  TradingViewPeriodScreenshotInputSchema,
} from "../src/schemas.js";

const HISTORY: TradingViewHistoryResult = {
  symbol: "TSE:8697",
  interval: "D",
  source: "TradingView Supercharts chart-data export",
  authenticated: true,
  delayed: false,
  requestedBars: 2,
  requestedBarsSatisfied: true,
  barCount: 2,
  sourceBarCount: 2,
  truncated: false,
  file: "/tmp/tradingview-exports/TSE-8697-D.csv",
  bytes: 128,
  firstBar: { time: 1_700_000_000, open: 1, high: 3, low: 1, close: 2, volume: 10 },
  lastBar: { time: 1_700_086_400, open: 2, high: 4, low: 2, close: 3, volume: 11 },
  bars: [
    { time: 1_700_000_000, open: 1, high: 3, low: 1, close: 2, volume: 10 },
    { time: 1_700_086_400, open: 2, high: 4, low: 2, close: 3, volume: 11 },
  ],
};

const RANGE_HISTORY: TradingViewDateRangeHistoryResult = {
  ...HISTORY,
  requestedRange: { from: "2023-01-01", to: "2023-11-16" },
  chartTimezone: "UTC",
  exportRows: HISTORY.bars.map((bar) => ({ bar, fields: {} })),
};

describe("MCP TradingView workflows", () => {
  it("rejects invalid dates, reversed ranges, and unknown timezones before browser work", () => {
    expect(() =>
      TradingViewDayInputSchema.parse({
        symbol: "NASDAQ:AAPL",
        date: "2024-02-30",
        timezone: "Mars/Olympus_Mons",
      }),
    ).toThrow();
    expect(() =>
      TradingViewPeriodScreenshotInputSchema.parse({
        symbol: "NASDAQ:AAPL",
        from: "2024-02-01",
        to: "2024-01-01",
      }),
    ).toThrow(/end date/i);
    expect(() =>
      TradingViewDayInputSchema.parse({
        symbol: "NASDAQ:AAPL",
        date: "2024-02-01",
        interval: "W",
      }),
    ).toThrow(/daily, minutes, or hours/i);
  });

  it("returns compact history and closes the browser by default", async () => {
    const browser = {
      getHistory: vi.fn(async () => HISTORY),
      close: vi.fn(async () => undefined),
    };

    const result = await getTradingViewHistoryForMcp(
      browser,
      TradingViewMcpHistoryInputSchema.parse({ symbol: "TSE:8697", interval: "D", bars: 2 }),
    );

    expect(result).not.toHaveProperty("bars");
    expect(result).toMatchObject({ symbol: "TSE:8697", barCount: 2, firstBar: HISTORY.firstBar });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("loads history before analysis and can keep the browser for follow-up tools", async () => {
    const browser = {
      getHistory: vi.fn(async () => HISTORY),
      close: vi.fn(async () => undefined),
    };
    const analyze = vi.fn(() => ({ summary: "deterministic analysis" }));

    const result = await analyzeTradingViewSymbolForMcp(
      browser,
      analyze,
      TradingViewAnalyzeInputSchema.parse({
        symbol: "TSE:8697",
        interval: "D",
        bars: 2,
        includeHistoryBars: true,
        keepBrowserOpen: true,
      }),
    );

    expect(browser.getHistory).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "TSE:8697", loadChart: true }),
    );
    expect(result.history).toHaveProperty("bars", HISTORY.bars);
    expect(result.analysis).toEqual({ summary: "deterministic analysis" });
    expect(analyze).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it("closes the browser when an automatic history workflow fails", async () => {
    const browser = {
      getHistory: vi.fn(async () => {
        throw new Error("export failed");
      }),
      close: vi.fn(async () => undefined),
    };

    await expect(
      getTradingViewHistoryForMcp(
        browser,
        TradingViewMcpHistoryInputSchema.parse({ symbol: "TSE:8697", interval: "D" }),
      ),
    ).rejects.toThrow("export failed");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("gets one date through a bounded TradingView custom-range export", async () => {
    const browser = {
      getDateRangeHistory: vi.fn(async () => RANGE_HISTORY),
      close: vi.fn(async () => undefined),
    };

    const result = await getTradingViewDayForMcp(
      browser,
      TradingViewDayInputSchema.parse({
        symbol: "TSE:8697",
        date: "2023-11-15",
        interval: "D",
        timezone: "UTC",
        lookbackBars: 2,
      }),
    );

    expect(browser.getDateRangeHistory).toHaveBeenCalledWith({
      symbol: "TSE:8697",
      interval: "D",
      from: "2023-11-05",
      to: "2023-11-16",
      bars: 2,
    });
    expect(result).toMatchObject({ requestedDate: "2023-11-15", status: "complete" });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("captures an exact period and closes the browser by default", async () => {
    const capture = {
      png: Buffer.from("png"),
      state: {
        url: "https://www.tradingview.com/chart/",
        title: "AAPL chart",
        symbol: "NASDAQ:AAPL",
        interval: "D",
        authenticated: false,
        delayed: true,
      },
      requestedRange: { from: "2024-01-01", to: "2024-01-31" },
      chartTimezone: "UTC",
      width: 1_440,
      height: 900,
      chartOnly: true,
    };
    const browser = {
      capturePeriod: vi.fn(async () => capture),
      close: vi.fn(async () => undefined),
    };

    const result = await captureTradingViewPeriodForMcp(
      browser,
      TradingViewPeriodScreenshotInputSchema.parse({
        symbol: "NASDAQ:AAPL",
        from: "2024-01-01",
        to: "2024-01-31",
      }),
    );

    expect(result).toEqual(capture);
    expect(browser.capturePeriod).toHaveBeenCalledWith({
      symbol: "NASDAQ:AAPL",
      interval: "D",
      from: "2024-01-01",
      to: "2024-01-31",
      width: 1_440,
      height: 900,
      chartOnly: true,
    });
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
