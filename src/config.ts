import path from "node:path";

export interface AppConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  dataRoot: string;
  apiToken?: string;
  rapidApiKey?: string;
  rapidApiHost: string;
  screenshotsEnabled: boolean;
  tradingViewBrowser: {
    enabled: boolean;
    baseUrl: "https://jp.tradingview.com" | "https://www.tradingview.com";
    authStatePath?: string;
    cookieFile?: string;
    headless: boolean;
    timeoutMs: number;
    downloadsDir: string;
  };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const hostValue = (env.MARKET_CHART_HOST ?? "127.0.0.1").trim();
  if (hostValue !== "127.0.0.1" && hostValue !== "::1" && hostValue !== "localhost") {
    throw new Error(
      "MARKET_CHART_HOST must be loopback-only (127.0.0.1, ::1, or localhost).",
    );
  }
  const port = parsePort(env.MARKET_CHART_PORT ?? "4317");
  const apiToken = cleanOptional(env.MARKET_CHART_API_TOKEN);
  const rapidApiKey = cleanOptional(
    env.TRADINGVIEW_RAPIDAPI_KEY ?? env.RAPIDAPI_KEY ?? env.X_RAPIDAPI_KEY,
  );
  if (rapidApiKey && !apiToken) {
    throw new Error(
      "MARKET_CHART_API_TOKEN is required when TRADINGVIEW_RAPIDAPI_KEY is configured.",
    );
  }
  const rapidApiHost = (
    env.TRADINGVIEW_RAPIDAPI_HOST ?? "tradingview-data1.p.rapidapi.com"
  ).trim();
  if (!/^[a-zA-Z0-9.-]+$/.test(rapidApiHost)) {
    throw new Error("TRADINGVIEW_RAPIDAPI_HOST must be a hostname without a URL path.");
  }
  const dataRoot = path.resolve(cwd, env.MARKET_CHART_DATA_ROOT?.trim() || "data");
  const browserEnabled = parseBoolean(env.TRADINGVIEW_BROWSER_ENABLED, false);
  const browserBaseUrl = parseTradingViewBaseUrl(
    env.TRADINGVIEW_BROWSER_BASE_URL ?? "https://www.tradingview.com",
  );
  const authStatePath = resolveOptionalPath(env.TRADINGVIEW_BROWSER_AUTH_STATE, cwd);
  const cookieFile = resolveOptionalPath(env.TRADINGVIEW_BROWSER_COOKIE_FILE, cwd);
  const timeoutMs = parseBoundedInteger(
    env.TRADINGVIEW_BROWSER_TIMEOUT_MS ?? "30000",
    "TRADINGVIEW_BROWSER_TIMEOUT_MS",
    5_000,
    120_000,
  );

  return {
    host: hostValue === "localhost" ? "127.0.0.1" : hostValue,
    port,
    dataRoot,
    ...(apiToken ? { apiToken } : {}),
    ...(rapidApiKey ? { rapidApiKey } : {}),
    rapidApiHost,
    screenshotsEnabled: parseBoolean(env.MARKET_CHART_SCREENSHOTS, true),
    tradingViewBrowser: {
      enabled: browserEnabled,
      baseUrl: browserBaseUrl,
      ...(authStatePath ? { authStatePath } : {}),
      ...(cookieFile ? { cookieFile } : {}),
      headless: parseBoolean(env.TRADINGVIEW_BROWSER_HEADLESS, true),
      timeoutMs,
      downloadsDir: path.join(dataRoot, "tradingview-exports"),
    },
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid MARKET_CHART_PORT: ${value}`);
  }
  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function resolveOptionalPath(value: string | undefined, cwd: string): string | undefined {
  const cleaned = cleanOptional(value);
  return cleaned ? path.resolve(cwd, cleaned) : undefined;
}

function parseTradingViewBaseUrl(
  value: string,
): "https://jp.tradingview.com" | "https://www.tradingview.com" {
  const normalized = value.trim().replace(/\/+$/, "");
  if (normalized === "https://jp.tradingview.com" || normalized === "https://www.tradingview.com") {
    return normalized;
  }
  throw new Error(
    "TRADINGVIEW_BROWSER_BASE_URL must be https://jp.tradingview.com or https://www.tradingview.com.",
  );
}

function parseBoundedInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}
