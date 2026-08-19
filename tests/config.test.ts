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
      authCookieNames: ["sessionid", "sessionid_sign", "device_t"],
      authStorageKeys: [],
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
      authCookieNames: ["sessionid", "sessionid_sign", "device_t"],
      authStorageKeys: [],
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

  it("rejects ambiguous authentication sources", () => {
    expect(() =>
      loadConfig(
        {
          TRADINGVIEW_BROWSER_AUTH_STATE: "state.json",
          TRADINGVIEW_BROWSER_COOKIE_FILE: "cookies.txt",
        },
        "/tmp/market-chart-config-test",
      ),
    ).toThrow(/only one TradingView authentication source/i);
  });

  it("supports explicit minimal authentication allowlists", () => {
    const config = loadConfig(
      {
        TRADINGVIEW_BROWSER_COOKIE_FILE: "cookies.txt",
        TRADINGVIEW_BROWSER_AUTH_COOKIE_NAMES: "sessionid, sessionid_sign, SESSIONID",
        TRADINGVIEW_BROWSER_AUTH_STORAGE_KEYS: "auth_marker, device_id",
      },
      "/tmp/market-chart-config-test",
    );
    expect(config.tradingViewBrowser.authCookieNames).toEqual([
      "sessionid",
      "sessionid_sign",
      "SESSIONID",
    ]);
    expect(config.tradingViewBrowser.authStorageKeys).toEqual(["auth_marker", "device_id"]);
  });

  it("rejects empty or malformed authentication cookie policies", () => {
    expect(() =>
      loadConfig(
        {
          TRADINGVIEW_BROWSER_COOKIE_FILE: "cookies.txt",
          TRADINGVIEW_BROWSER_AUTH_COOKIE_NAMES: "",
        },
        "/tmp/market-chart-config-test",
      ),
    ).toThrow(/must allow at least one cookie/i);
    expect(() =>
      loadConfig(
        { TRADINGVIEW_BROWSER_AUTH_COOKIE_NAMES: "sessionid,not allowed" },
        "/tmp/market-chart-config-test",
      ),
    ).toThrow(/comma-separated ASCII names/i);
  });

  it("requires the supported English TradingView origin", () => {
    expect(() =>
      loadConfig(
        { TRADINGVIEW_BROWSER_BASE_URL: "https://es.tradingview.com" },
        "/tmp/market-chart-config-test",
      ),
    ).toThrow(/supported English UI/i);
  });
});
