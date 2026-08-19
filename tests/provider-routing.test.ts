import { afterEach, describe, expect, it, vi } from "vitest";

import { ChartStore } from "../src/chart-store.js";
import type { Bar } from "../src/domain.js";
import { MarketService } from "../src/market-service.js";
import { TradingViewDataClient } from "../src/rapidapi.js";

const bars: Bar[] = [
  { time: 1_700_000_000, open: 100, high: 102, low: 99, close: 101, volume: 1_000 },
  { time: 1_700_000_300, open: 101, high: 104, low: 100, close: 103, volume: 1_200 },
];

function createLiveMarket(): MarketService {
  const store = new ChartStore({ bars, symbol: "NASDAQ:AAPL", interval: "5" });
  return new MarketService(
    store,
    new TradingViewDataClient("test-rapid-key", "tradingview-data1.p.rapidapi.com"),
  );
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("live provider routing", () => {
  it("forwards current price, OHLCV, batch, and search contracts without dropping fields", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ success: true, data: {}, msg: "Success" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const market = createLiveMarket();

    await market.price("NASDAQ:AAPL");
    await market.ohlcv("NASDAQ:AAPL", "60", 25, { to: 1_700_000_000, strictTo: true });
    await market.priceBatch([
      { symbol: "NASDAQ:AAPL", timeframe: "D", range: 12, type: "HeikinAshi" },
    ]);
    await market.search("apple", {
      filter: "stock",
      hl: 1,
      exchange: "NASDAQ",
      lang: "en",
      sort_by_country: "US",
      enable_grouping: true,
    });

    const firstUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(firstUrl.pathname).toBe("/api/price/NASDAQ%3AAAPL");
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({ timeframe: "5", range: "10" });

    const ohlcvUrl = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(ohlcvUrl.pathname).toBe("/api/price/ohlcv/NASDAQ%3AAAPL");
    expect(Object.fromEntries(ohlcvUrl.searchParams)).toEqual({
      timeframe: "60",
      range: "25",
      to: "1700000000",
      strictTo: "true",
    });

    const batchInit = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(JSON.parse(String(batchInit.body))).toEqual({
      requests: [
        { symbol: "NASDAQ:AAPL", timeframe: "D", range: 12, type: "HeikinAshi" },
      ],
    });

    const searchUrl = new URL(String(fetchMock.mock.calls[3]![0]));
    expect(searchUrl.pathname).toBe("/api/search/market/apple");
    expect(Object.fromEntries(searchUrl.searchParams)).toEqual({
      filter: "stock",
      hl: "1",
      exchange: "NASDAQ",
      lang: "en",
      sort_by_country: "US",
      enable_grouping: "true",
    });
  });

  it("maps batch quotes and nested news items into the public Actor snapshot shape", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/quote/batch") {
        return jsonResponse({
          success: true,
          data: {
            total: 1,
            successful: 1,
            failed: 0,
            data: [
              {
                success: true,
                symbol: "NASDAQ:AAPL",
                data: {
                  lp: 210.5,
                  ch: -2.6,
                  chp: -1.22,
                  volume: 1_500_000,
                  description: "Apple Inc.",
                  logoid: "apple",
                },
              },
            ],
          },
          msg: "Success",
        });
      }
      if (url.pathname === "/api/news") {
        return jsonResponse({
          success: true,
          data: {
            items: [
              {
                title: "Apple headline",
                storyPath: "/news/example-story/",
                published: 1_700_000_000,
              },
            ],
          },
          msg: "Success",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createLiveMarket().stockSnapshots({
        symbols: ["NASDAQ:AAPL"],
        scrapeNewsHeadlines: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        symbol: "NASDAQ:AAPL",
        price: 210.5,
        change: -1.22,
        logoUrl: "https://s3-symbol-logo.tradingview.com/apple.svg",
        news: [
          {
            title: "Apple headline",
            url: "https://www.tradingview.com/news/example-story/",
            published: "2023-11-14T22:13:20.000Z",
          },
        ],
      }),
    ]);
  });
});
