import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("keeps local mode usable without credentials", () => {
    const config = loadConfig({}, "/tmp/market-chart-config-test");
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4317,
      dataRoot: path.resolve("/tmp/market-chart-config-test/data"),
      screenshotsEnabled: true,
    });
    expect(config.rapidApiKey).toBeUndefined();
    expect(config.apiToken).toBeUndefined();
    expect(config.tradingViewBrowser).toMatchObject({
      enabled: false,
      baseUrl: "https://www.tradingview.com",
      headless: true,
      timeoutMs: 30_000,
      downloadsDir: path.resolve("/tmp/market-chart-config-test/data/tradingview-exports"),
    });
  });

  it("requires bearer protection whenever the billable upstream key is configured", () => {
    expect(() =>
      loadConfig({ TRADINGVIEW_RAPIDAPI_KEY: "rapid-secret" }, "/tmp/market-chart-config-test"),
    ).toThrow(/MARKET_CHART_API_TOKEN is required/);

    expect(
      loadConfig(
        {
          TRADINGVIEW_RAPIDAPI_KEY: "rapid-secret",
          MARKET_CHART_API_TOKEN: "local-bearer-secret",
        },
        "/tmp/market-chart-config-test",
      ),
    ).toMatchObject({
      rapidApiKey: "rapid-secret",
      apiToken: "local-bearer-secret",
    });
  });

  it("loads TradingView browser authentication only by local file reference", () => {
    const config = loadConfig(
      {
        TRADINGVIEW_BROWSER_ENABLED: "true",
        TRADINGVIEW_BROWSER_COOKIE_FILE: "secrets/tradingview-cookies.txt",
        TRADINGVIEW_BROWSER_HEADLESS: "false",
        TRADINGVIEW_BROWSER_TIMEOUT_MS: "45000",
      },
      "/tmp/market-chart-config-test",
    );
    expect(config.tradingViewBrowser).toEqual({
      enabled: true,
      baseUrl: "https://www.tradingview.com",
      cookieFile: path.resolve(
        "/tmp/market-chart-config-test/secrets/tradingview-cookies.txt",
      ),
      headless: false,
      timeoutMs: 45_000,
      downloadsDir: path.resolve("/tmp/market-chart-config-test/data/tradingview-exports"),
    });
  });

  it("rejects arbitrary TradingView browser origins", () => {
    expect(() =>
      loadConfig(
        { TRADINGVIEW_BROWSER_BASE_URL: "https://example.com" },
        "/tmp/market-chart-config-test",
      ),
    ).toThrow(/TRADINGVIEW_BROWSER_BASE_URL/);
  });
});
