import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiServer } from "../src/api.js";
import { ChartStore } from "../src/chart-store.js";
import type { AppConfig } from "../src/config.js";
import type { Bar } from "../src/domain.js";
import { MarketService } from "../src/market-service.js";
import { TradingViewDataClient } from "../src/rapidapi.js";
import type { TradingViewCaptureBatchManifest } from "../src/schemas.js";
import { TradingViewBrowserService } from "../src/tradingview-browser.js";

const bars: Bar[] = [
  { time: 1_700_000_000, open: 100, high: 105, low: 98, close: 102, volume: 1_000 },
  { time: 1_700_086_400, open: 102, high: 110, low: 101, close: 108, volume: 1_500 },
  { time: 1_700_172_800, open: 108, high: 112, low: 104, close: 106, volume: 1_200 },
];

describe("Fastify API", () => {
  let app: FastifyInstance;
  let dataRoot: string;
  let config: AppConfig;
  let tradingViewBrowser: TradingViewBrowserService;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "market-chart-api-test-"));
    const store = new ChartStore({
      bars,
      symbol: "NASDAQ:AAPL",
      interval: "1D",
      source: "api-test",
    });
    config = {
      host: "127.0.0.1",
      port: 0,
      dataRoot,
      apiToken: "test-token",
      rapidApiHost: "example.invalid",
      screenshotsEnabled: false,
      tradingViewBrowser: {
        enabled: false,
        baseUrl: "https://www.tradingview.com",
        authCookieNames: ["sessionid", "sessionid_sign", "device_t"],
        authStorageKeys: [],
        headless: true,
        timeoutMs: 30_000,
        downloadsDir: path.join(dataRoot, "tradingview-exports"),
      },
    };
    const market = new MarketService(
      store,
      new TradingViewDataClient(undefined, config.rapidApiHost),
    );
    tradingViewBrowser = new TradingViewBrowserService(
      config.tradingViewBrowser,
      config.dataRoot,
      store,
    );
    app = await createApiServer({ config, store, market, tradingViewBrowser });
  });

  afterEach(async () => {
    await Promise.all([app.close(), tradingViewBrowser.close()]);
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("exposes unauthenticated health while protecting API and compatibility routes", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      success: true,
      data: {
        status: "ok",
        service: "tradingview-mcp",
        upstreamConfigured: false,
        tradingViewBrowserEnabled: false,
        revision: 1,
      },
    });
    expect(health.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
    });

    const unauthorized = await app.inject({ method: "GET", url: "/api/chart/state" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Valid Bearer token required." },
    });

    const authorized = await app.inject({
      method: "GET",
      url: "/api/chart/state",
      headers: { authorization: "Bearer test-token" },
    });
    expect(authorized.statusCode).toBe(200);

    const unauthorizedCompatibility = await app.inject({
      method: "POST",
      url: "/v2/acts/mscraper~tradingview-stock-scraper/run-sync-get-dataset-items",
      payload: { symbols: ["NASDAQ:AAPL"] },
    });
    expect(unauthorizedCompatibility.statusCode).toBe(401);

    const encodedApi = await app.inject({ method: "GET", url: "/%61pi/chart/state" });
    expect(encodedApi.statusCode).toBe(401);

    const encodedMutation = await app.inject({
      method: "PATCH",
      url: "/%61pi/chart/view",
      payload: { symbol: "NASDAQ:BYPASS" },
    });
    expect(encodedMutation.statusCode).toBe(401);

    const encodedCompatibility = await app.inject({
      method: "POST",
      url: "/v2/%61cts/mscraper~tradingview-stock-scraper/run-sync-get-dataset-items",
      payload: { symbols: ["NASDAQ:AAPL"] },
    });
    expect(encodedCompatibility.statusCode).toBe(401);
  });

  it("rejects non-loopback Host headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "example.com" },
    });

    expect(response.statusCode).toBe(421);
    expect(response.json()).toEqual({
      success: false,
      error: { code: "INVALID_HOST", message: "Loopback Host header required." },
    });

    for (const host of ["localhost.example.com", "::1.example.com", "127.0.0.1.example.com"]) {
      const spoofed = await app.inject({ method: "GET", url: "/api/health", headers: { host } });
      expect(spoofed.statusCode).toBe(421);
    }
  });

  it("rejects cross-site browser calls before they can reach data providers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/quote/NASDAQ%3AAAPL",
      headers: {
        authorization: "Bearer test-token",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: "CROSS_SITE_REQUEST",
        message: "Cross-site browser API requests are blocked.",
      },
    });
  });

  it("serves local price compatibility and reports invalid queries safely", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/price/NASDAQ%3AAAPL?timeframe=D&range=2",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        symbol: "NASDAQ:AAPL",
        current: { time: bars[2]!.time, close: 106, max: 112, min: 104 },
        history: [{ time: bars[2]!.time }, { time: bars[1]!.time }],
      },
    });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/price/NASDAQ%3AAAPL?range=not-an-integer",
      headers: { authorization: "Bearer test-token" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      success: false,
      error: {
        code: "REQUEST_FAILED",
        message: "Expected an integer; received not-an-integer.",
      },
    });
  });

  it("updates and reads chart data through authenticated routes", async () => {
    const updatedBars = [
      { time: 1_800_000_000_000, open: "20", high: "22", low: "19", close: "21", volume: 500 },
      { time: 1_800_086_400_000, open: "21", high: "24", low: "20", close: "23", volume: 700 },
    ];
    const update = await app.inject({
      method: "POST",
      url: "/api/chart/data",
      headers: { authorization: "Bearer test-token" },
      payload: { symbol: "NYSE:TEST", interval: "1D", source: "api-client", bars: updatedBars },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      symbol: "NYSE:TEST",
      interval: "1D",
      source: "api-client",
      revision: 2,
      bars: [
        { time: 1_800_000_000, open: 20, high: 22, low: 19, close: 21, volume: 500 },
        { time: 1_800_086_400, open: 21, high: 24, low: 20, close: 23, volume: 700 },
      ],
    });

    const summary = await app.inject({
      method: "GET",
      url: "/api/chart/summary",
      headers: { authorization: "Bearer test-token" },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ symbol: "NYSE:TEST", barCount: 2, revision: 2 });
  });

  it("returns normalized TradingView history through one protected request", async () => {
    const historyBars = bars.slice(-2).map((bar) => ({ ...bar }));
    const getHistory = vi.spyOn(tradingViewBrowser, "getHistory").mockResolvedValue({
      symbol: "OSE:NK2251!",
      interval: "W",
      source: "TradingView Supercharts chart-data export",
      authenticated: true,
      delayed: false,
      requestedBars: 2,
      requestedBarsSatisfied: true,
      barCount: 2,
      sourceBarCount: 500,
      truncated: true,
      file: "tradingview-exports/OSE-NK2251-W-test.csv",
      bytes: 12_345,
      firstBar: historyBars[0]!,
      lastBar: historyBars[1]!,
      bars: historyBars,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tradingview/history",
      headers: { authorization: "Bearer test-token" },
      payload: { symbol: "OSE:NK2251!", interval: "W", bars: 2, loadChart: false },
    });

    expect(response.statusCode).toBe(200);
    expect(getHistory).toHaveBeenCalledWith({
      symbol: "OSE:NK2251!",
      interval: "W",
      bars: 2,
      loadChart: false,
    });
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        symbol: "OSE:NK2251!",
        interval: "W",
        barCount: 2,
        sourceBarCount: 500,
        bars: historyBars,
      },
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/tradingview/history",
      headers: { authorization: "Bearer test-token" },
      payload: { symbol: "../../etc/passwd", interval: "D" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ success: false, error: { code: "INVALID_INPUT" } });
  });

  it("opens and inspects an official TradingView chart through protected loopback routes", async () => {
    const state = {
      url: "https://www.tradingview.com/chart/layout_123/?symbol=OSE%3ANK2251%21&interval=240",
      title: "Nikkei 225 Futures - TradingView",
      symbol: "OSE:NK2251!",
      interval: "240",
      authenticated: true,
      chartLabel: "Chart for OSE:NK2251!",
      delayed: false,
    };
    const openChart = vi.spyOn(tradingViewBrowser, "openChart").mockResolvedValue(state);
    const getState = vi.spyOn(tradingViewBrowser, "getState").mockResolvedValue(state);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/open",
      payload: { symbol: "OSE:NK2251!", interval: "240" },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(openChart).not.toHaveBeenCalled();

    const opened = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/open",
      headers: { authorization: "Bearer test-token" },
      payload: { symbol: "OSE:NK2251!", interval: "240", layoutId: "layout_123" },
    });
    expect(opened.statusCode).toBe(200);
    expect(openChart).toHaveBeenCalledWith({
      symbol: "OSE:NK2251!",
      interval: "240",
      layoutId: "layout_123",
    });
    expect(opened.json()).toEqual({ success: true, data: state });

    const inspected = await app.inject({
      method: "GET",
      url: "/api/tradingview/chart/state",
      headers: { authorization: "Bearer test-token" },
    });
    expect(inspected.statusCode).toBe(200);
    expect(getState).toHaveBeenCalledOnce();
    expect(inspected.json()).toEqual({ success: true, data: state });

    const invalidLayout = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/open",
      headers: { authorization: "Bearer test-token" },
      payload: { symbol: "OSE:NK2251!", interval: "240", layoutId: "../private" },
    });
    expect(invalidLayout.statusCode).toBe(400);
    expect(invalidLayout.json()).toMatchObject({
      success: false,
      error: { code: "INVALID_INPUT" },
    });

    const secretInput = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/open",
      headers: { authorization: "Bearer test-token" },
      payload: {
        symbol: "OSE:NK2251!",
        interval: "240",
        cookies: [{ name: "sessionid", value: "must-not-be-accepted" }],
      },
    });
    expect(secretInput.statusCode).toBe(400);
    expect(openChart).toHaveBeenCalledTimes(1);
  });

  it("returns bounded official TradingView screenshots as raw protected PNG responses", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const snapshot = vi.spyOn(tradingViewBrowser, "snapshot").mockResolvedValue(png);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/snapshot",
      payload: { width: 1_280, height: 720, chartOnly: true },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(snapshot).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/snapshot",
      headers: { authorization: "Bearer test-token" },
      payload: { width: 1_280, height: 720, chartOnly: false },
    });
    expect(response.statusCode).toBe(200);
    expect(snapshot).toHaveBeenCalledWith({ width: 1_280, height: 720, chartOnly: false });
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-length"]).toBe(String(png.byteLength));
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(png);

    const invalidSize = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/snapshot",
      headers: { authorization: "Bearer test-token" },
      payload: { width: 639, height: 720, chartOnly: true },
    });
    expect(invalidSize.statusCode).toBe(400);
    expect(invalidSize.json()).toMatchObject({
      success: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("routes only the exact strict official six-panel capture contract", async () => {
    const manifest = {
      batchId: "capture-batch-test",
      manifestIdentity: `sha256:${"a".repeat(64)}`,
    } as unknown as TradingViewCaptureBatchManifest;
    const captureBatch = vi.spyOn(tradingViewBrowser, "captureBatch").mockResolvedValue(manifest);
    const payload = {
      symbol: "OSE:NK2251!",
      intervals: ["5", "60", "240", "D", "W", "M"],
      layoutId: "example_layout",
      width: 1_800,
      height: 850,
      chartOnly: false,
      requireAuthenticated: true,
      allowDelayed: false,
      expectedOverlayMode: "saved_layout_pine",
      expectedIndicator: { identity: "PUB;author/script", name: "Manager Ichimoku" },
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/capture-batch",
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(captureBatch).not.toHaveBeenCalled();

    const captured = await app.inject({
      method: "POST",
      url: "/api/tradingview/chart/capture-batch",
      headers: { authorization: "Bearer test-token" },
      payload,
    });
    expect(captured.statusCode).toBe(200);
    expect(captureBatch).toHaveBeenCalledWith(payload);
    expect(captured.json()).toEqual({ success: true, data: manifest });

    for (const invalidPayload of [
      { ...payload, width: 1_799 },
      { ...payload, intervals: ["5", "60", "240", "D", "M", "W"] },
      { ...payload, expectedIndicator: undefined },
      { ...payload, cookies: [{ name: "sessionid", value: "must-not-be-accepted" }] },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/tradingview/chart/capture-batch",
        headers: { authorization: "Bearer test-token" },
        payload: invalidPayload,
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ success: false, error: { code: "INVALID_INPUT" } });
    }
    expect(captureBatch).toHaveBeenCalledTimes(1);
  });

  it("routes the existing OHLCV contract through the browser for supported intraday bars", async () => {
    config.tradingViewBrowser.enabled = true;
    const historyBars = bars.slice(-2).map((bar) => ({ ...bar }));
    const getHistory = vi.spyOn(tradingViewBrowser, "getHistory").mockResolvedValue({
      symbol: "OSE:NK225M1!",
      interval: "240",
      source: "TradingView Supercharts chart-data export",
      authenticated: true,
      delayed: false,
      requestedBars: 2,
      requestedBarsSatisfied: true,
      barCount: 2,
      sourceBarCount: 236,
      truncated: true,
      file: "tradingview-exports/OSE-NK225M1-240-test.csv",
      bytes: 12_345,
      firstBar: historyBars[0]!,
      lastBar: historyBars[1]!,
      bars: historyBars,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/price/ohlcv/OSE%3ANK225M1!" +
        `?timeframe=240&range=2&to=${bars[1]!.time}&strictTo=true`,
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(getHistory).toHaveBeenCalledWith({
      symbol: "OSE:NK225M1!",
      interval: "240",
      bars: 2,
      loadChart: false,
    });
    expect(response.json()).toEqual({
      success: true,
      data: {
        symbol: "OSE:NK225M1!",
        current: {
          time: historyBars[1]!.time,
          open: historyBars[1]!.open,
          close: historyBars[1]!.close,
          max: historyBars[1]!.high,
          min: historyBars[1]!.low,
          volume: historyBars[1]!.volume,
        },
        history: [
          {
            time: historyBars[1]!.time,
            open: historyBars[1]!.open,
            close: historyBars[1]!.close,
            max: historyBars[1]!.high,
            min: historyBars[1]!.low,
            volume: historyBars[1]!.volume,
          },
          {
            time: historyBars[0]!.time,
            open: historyBars[0]!.open,
            close: historyBars[0]!.close,
            max: historyBars[0]!.high,
            min: historyBars[0]!.low,
            volume: historyBars[0]!.volume,
          },
        ],
        info: {
          source: "TradingView Supercharts chart-data export",
          interval: "240",
          authenticated: true,
          delayed: false,
          requestedBars: 2,
          requestedBarsSatisfied: true,
          sourceBarCount: 236,
          requestedTo: bars[1]!.time,
          strictTo: true,
          toApplied: false,
        },
      },
      msg: "Success",
    });

    getHistory.mockResolvedValue({
      symbol: "OSE:NK225U2026",
      interval: "1",
      source: "TradingView Supercharts chart-data export",
      authenticated: true,
      delayed: false,
      requestedBars: 2,
      requestedBarsSatisfied: true,
      barCount: 2,
      sourceBarCount: 236,
      truncated: true,
      file: "tradingview-exports/OSE-NK225U2026-1-test.csv",
      bytes: 12_345,
      firstBar: historyBars[0]!,
      lastBar: historyBars[1]!,
      bars: historyBars,
    });
    const minute = await app.inject({
      method: "GET",
      url: "/api/price/ohlcv/OSE%3ANK225U2026?timeframe=1&range=2",
      headers: { authorization: "Bearer test-token" },
    });
    expect(minute.statusCode).toBe(200);
    expect(getHistory).toHaveBeenLastCalledWith({
      symbol: "OSE:NK225U2026",
      interval: "1",
      bars: 2,
      loadChart: false,
    });
    expect(minute.json()).toMatchObject({
      data: {
        symbol: "OSE:NK225U2026",
        info: {
          source: "TradingView Supercharts chart-data export",
          interval: "1",
          authenticated: true,
        },
      },
    });

    getHistory.mockResolvedValue({
      symbol: "OSE:NK2251!",
      interval: "5",
      source: "TradingView Supercharts chart-data export",
      authenticated: true,
      delayed: false,
      requestedBars: 2,
      requestedBarsSatisfied: true,
      barCount: 2,
      sourceBarCount: 236,
      truncated: true,
      file: "tradingview-exports/OSE-NK2251-5-test.csv",
      bytes: 12_345,
      firstBar: historyBars[0]!,
      lastBar: historyBars[1]!,
      bars: historyBars,
    });
    const fiveMinute = await app.inject({
      method: "GET",
      url: "/api/price/ohlcv/OSE%3ANK2251!?timeframe=5&range=2",
      headers: { authorization: "Bearer test-token" },
    });
    expect(fiveMinute.statusCode).toBe(200);
    expect(getHistory).toHaveBeenLastCalledWith({
      symbol: "OSE:NK2251!",
      interval: "5",
      bars: 2,
      loadChart: false,
    });
    expect(fiveMinute.json()).toMatchObject({
      data: {
        symbol: "OSE:NK2251!",
        info: {
          source: "TradingView Supercharts chart-data export",
          interval: "5",
          authenticated: true,
        },
      },
    });
  });

  it("routes CME 60-minute history through the authenticated browser", async () => {
    config.tradingViewBrowser.enabled = true;
    const historyBars = bars.slice(-2).map((bar) => ({ ...bar }));
    const getHistory = vi.spyOn(tradingViewBrowser, "getHistory").mockResolvedValue({
      symbol: "CME:NKD1!",
      interval: "60",
      source: "TradingView Supercharts chart-data export",
      authenticated: true,
      delayed: false,
      requestedBars: 2,
      requestedBarsSatisfied: true,
      barCount: 2,
      sourceBarCount: 236,
      truncated: true,
      file: "tradingview-exports/CME-NKD1-60-test.csv",
      bytes: 12_345,
      firstBar: historyBars[0]!,
      lastBar: historyBars[1]!,
      bars: historyBars,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/price/ohlcv/CME%3ANKD1!" +
        `?timeframe=60&range=2&to=${bars[1]!.time}&strictTo=true`,
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(getHistory).toHaveBeenCalledWith({
      symbol: "CME:NKD1!",
      interval: "60",
      bars: 2,
      loadChart: false,
    });
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        symbol: "CME:NKD1!",
        info: {
          source: "TradingView Supercharts chart-data export",
          interval: "60",
          authenticated: true,
        },
      },
    });
  });

  it("publishes a complete analysis overlay bundle through one authenticated request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chart/overlays",
      headers: { authorization: "Bearer test-token" },
      payload: {
        replace: true,
        indicators: [
          { id: "roman", kind: "bollinger", period: 25, standardDeviations: 1, color: "#ef4444" },
        ],
        levels: [{ id: "pain", price: 105, label: "Max Pain", color: "#a78bfa" }],
        customSeries: [
          {
            id: "path",
            kind: "line",
            label: "Base scenario",
            pane: "price",
            color: "#f59e0b",
            lineWidth: 2,
            lineStyle: "dashed",
            data: [
              { time: bars[0]!.time, value: 101 },
              { time: bars[2]!.time, value: 108 },
            ],
          },
        ],
        zones: [
          {
            id: "range",
            startTime: bars[0]!.time,
            endTime: bars[2]!.time,
            upper: 112,
            lower: 98,
            label: "Expected range",
            color: "#38bdf8",
          },
        ],
        markers: [
          {
            id: "sq",
            time: bars[2]!.time,
            position: "aboveBar",
            shape: "circle",
            color: "#f8fafc",
            text: "SQ",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      indicators: [{ id: "roman" }],
      levels: [{ id: "pain" }],
      customSeries: [{ id: "path" }],
      zones: [{ id: "range" }],
      markers: [{ id: "sq" }],
    });
  });

  it("supports the local and public Apify-compatible synchronous dataset endpoints", async () => {
    const payload = {
      symbols: ["AAPL"],
      exchange: "NASDAQ",
      customFilters: [{ left: "close", operation: "greater", right: 100 }],
      scrapeNewsHeadlines: false,
    };
    const local = await app.inject({
      method: "POST",
      url: "/api/actor/tradingview-stock-scraper",
      headers: { authorization: "Bearer test-token" },
      payload,
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toEqual([
      expect.objectContaining({
        symbol: "NASDAQ:AAPL",
        ticker: "AAPL",
        price: 106,
        change: expect.closeTo((-2 / 108) * 100, 10),
        news: [],
      }),
    ]);

    const publicCompatibility = await app.inject({
      method: "POST",
      url: "/v2/acts/mscraper~tradingview-stock-scraper/run-sync-get-dataset-items",
      headers: { authorization: "Bearer test-token" },
      payload,
    });
    expect(publicCompatibility.statusCode).toBe(200);
    expect(publicCompatibility.json()).toEqual(local.json());
  });
});
