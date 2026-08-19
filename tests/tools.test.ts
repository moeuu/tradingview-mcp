import { describe, expect, it, vi } from "vitest";
import type { TradingViewHistoryResult } from "../src/tradingview-browser.js";
import {
  analyzeTradingViewSymbolForMcp,
  getTradingViewHistoryForMcp,
  TradingViewAnalyzeInputSchema,
  TradingViewMcpHistoryInputSchema,
} from "../src/tools.js";

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

describe("MCP TradingView workflows", () => {
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
});
