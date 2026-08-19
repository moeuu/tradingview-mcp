import { describe, expect, it } from "vitest";

import { ChartStore } from "../src/chart-store.js";
import type { Bar } from "../src/domain.js";
import { MarketService, extractBars } from "../src/market-service.js";
import { TradingViewDataClient } from "../src/rapidapi.js";

const bars: Bar[] = [
  { time: 1_700_000_000, open: 100, high: 105, low: 98, close: 102, volume: 1_000 },
  { time: 1_700_086_400, open: 102, high: 110, low: 101, close: 108, volume: 1_500 },
  { time: 1_700_172_800, open: 108, high: 112, low: 104, close: 106, volume: 1_200 },
];

function createLocalMarket(): { store: ChartStore; market: MarketService } {
  const store = new ChartStore({
    bars,
    symbol: "NASDAQ:AAPL",
    interval: "1D",
    source: "test-fixture",
  });
  const upstream = new TradingViewDataClient(undefined, "example.invalid");
  return { store, market: new MarketService(store, upstream) };
}

describe("MarketService local compatibility mode", () => {
  it("returns tradingviewapi-compatible newest-first price history with range and to filters", async () => {
    const { market } = createLocalMarket();

    await expect(market.price(" nasdaq:aapl ", "D", 2)).resolves.toEqual({
      success: true,
      data: {
        symbol: "NASDAQ:AAPL",
        current: {
          time: bars[2]!.time,
          open: 108,
          close: 106,
          max: 112,
          min: 104,
          volume: 1_200,
        },
        history: [
          {
            time: bars[2]!.time,
            open: 108,
            close: 106,
            max: 112,
            min: 104,
            volume: 1_200,
          },
          {
            time: bars[1]!.time,
            open: 102,
            close: 108,
            max: 110,
            min: 101,
            volume: 1_500,
          },
        ],
        info: { source: "test-fixture" },
      },
      msg: "Success",
    });

    const response = (await market.price("NASDAQ:AAPL", "D", 10, {
      to: bars[1]!.time,
    })) as { data: { current: { time: number }; history: Array<{ time: number }> } };
    expect(response.data.current.time).toBe(bars[1]!.time);
    expect(response.data.history.map((bar) => bar.time)).toEqual([bars[1]!.time, bars[0]!.time]);
  });

  it("returns local quote aliases, search results, and partial batch failures", async () => {
    const { market } = createLocalMarket();

    const quote = await market.quote("NASDAQ:AAPL");
    expect(quote).toMatchObject({
      success: true,
      data: {
        symbol: "NASDAQ:AAPL",
        data: {
          lp: 106,
          price: 106,
          change: -2,
          change_percent: expect.closeTo((-2 / 108) * 100, 10),
          ch: -2,
          open_price: 108,
          high_price: 112,
          low_price: 104,
          volume: 1_200,
          exchange: "NASDAQ",
        },
      },
    });
    await expect(market.search("aapl")).resolves.toMatchObject({
      success: true,
      data: {
        count: 1,
        markets: [{ symbol: "AAPL", full_name: "NASDAQ:AAPL", exchange: "NASDAQ" }],
      },
    });
    await expect(market.search("MSFT")).resolves.toEqual({
      success: true,
      data: { markets: [], count: 0 },
      msg: "Success",
    });

    const batch = (await market.priceBatch([
      { symbol: "NASDAQ:AAPL", timeframe: "D", range: 1 },
      { symbol: "NASDAQ:MSFT", timeframe: "D", range: 1 },
    ])) as {
      data: { total: number; successful: number; failed: number; data: Array<{ success: boolean }> };
    };
    expect(batch.data).toMatchObject({ total: 2, successful: 1, failed: 1 });
    expect(batch.data.data.map((entry) => entry.success)).toEqual([true, false]);
  });

  it("rejects symbols, intervals, and ranges unavailable in local mode", async () => {
    const { market } = createLocalMarket();

    await expect(market.price("NASDAQ:MSFT", "D", 1)).rejects.toThrow(/only NASDAQ:AAPL/i);
    await expect(market.price("NASDAQ:AAPL", "W", 1)).rejects.toThrow(/only loaded interval 1D/i);
    await expect(market.price("NASDAQ:AAPL", "D", 0)).rejects.toThrow(/range must be an integer/i);
    await expect(market.price("bad symbol!", "D", 1)).rejects.toThrow(/invalid symbol/i);
    await expect(
      market.price("NASDAQ:AAPL", "D", 1, { type: "HeikinAshi" }),
    ).rejects.toThrow(/local mode only supports standard OHLCV/i);
  });

  it("creates Apify-compatible stock snapshots and applies numeric and text filters", async () => {
    const { market } = createLocalMarket();

    await expect(
      market.stockSnapshots({
        symbols: ["AAPL"],
        exchange: "NASDAQ",
        customFilters: [
          { left: "close", operation: "greater_or_equal", right: 106 },
          { left: "change", operation: "less", right: 0 },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        symbol: "NASDAQ:AAPL",
        ticker: "AAPL",
        price: 106,
        change: expect.closeTo((-2 / 108) * 100, 10),
        volume: 1_200,
        news: [],
      }),
    ]);

    await expect(
      market.stockSnapshots({
        symbols: ["NASDAQ:AAPL"],
        customFilters: [{ left: "close", operation: "greater", right: 1_000 }],
      }),
    ).resolves.toEqual([]);
  });

  it("extracts, aliases, sorts, and deduplicates bars from permissive payloads", () => {
    expect(
      extractBars({
        data: {
          history: [
            { time: 2, o: 11, h: 13, l: 10, c: 12, v: 20 },
            { time: 1, open: 10, max: 12, min: 9, close: 11, volume: 10 },
            { ignored: true },
          ],
          current: { timestamp: 2, open: 11, high: 14, low: 10, close: 13, volume: 30 },
        },
      }),
    ).toEqual([
      { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 10 },
      { time: 2, open: 11, high: 14, low: 10, close: 13, volume: 30 },
    ]);
  });
});
