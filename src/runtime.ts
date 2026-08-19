import type { StartedApi } from "./api.js";
import { ChartStore } from "./chart-store.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { DEMO_BARS } from "./demo.js";
import { MarketService } from "./market-service.js";
import { TradingViewDataClient } from "./rapidapi.js";
import { ScreenshotService } from "./screenshot.js";
import { TradingViewBrowserService } from "./tradingview-browser.js";

export interface AppRuntime {
  config: AppConfig;
  store: ChartStore;
  market: MarketService;
  screenshots: ScreenshotService;
  tradingViewBrowser: TradingViewBrowserService;
  api: {
    readonly started: boolean;
    ensure(): Promise<StartedApi>;
    close(): Promise<void>;
  };
  close(): Promise<void>;
}

export async function createRuntime(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): Promise<AppRuntime> {
  const config = loadConfig(options.env, options.cwd);
  const store = new ChartStore({
    bars: DEMO_BARS.map((bar) => ({ ...bar })),
    symbol: "DEMO:MARKET",
    interval: "60",
    source: "synthetic-demo",
  });
  const upstream = new TradingViewDataClient(config.rapidApiKey, config.rapidApiHost);
  const market = new MarketService(store, upstream);
  const screenshots = new ScreenshotService(config.screenshotsEnabled);
  const tradingViewBrowser = new TradingViewBrowserService(
    config.tradingViewBrowser,
    config.dataRoot,
    store,
  );
  let apiPromise: Promise<StartedApi> | undefined;
  const apiDependencies = { config, store, market, tradingViewBrowser };
  const api = {
    get started() {
      return apiPromise !== undefined;
    },
    async ensure(): Promise<StartedApi> {
      if (apiPromise) return apiPromise;
      const pending = import("./api.js").then(({ startApiServer }) =>
        startApiServer(apiDependencies),
      );
      apiPromise = pending;
      try {
        return await pending;
      } catch (error) {
        if (apiPromise === pending) apiPromise = undefined;
        throw error;
      }
    },
    async close(): Promise<void> {
      const pending = apiPromise;
      apiPromise = undefined;
      if (!pending) return;
      const started = await pending.catch(() => undefined);
      await started?.close();
    },
  };

  return {
    config,
    store,
    market,
    screenshots,
    tradingViewBrowser,
    api,
    async close() {
      await Promise.allSettled([screenshots.close(), tradingViewBrowser.close(), api.close()]);
    },
  };
}
