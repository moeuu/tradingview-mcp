import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MCP_ENTRYPOINT = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));

function structuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || !("structuredContent" in result)) {
    throw new Error("Expected an MCP tool result with structuredContent.");
  }
  const value = (result as { structuredContent?: unknown }).structuredContent;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected structuredContent to be a JSON object.");
  }
  return value as Record<string, unknown>;
}

describe("MCP stdio server", () => {
  it("lists and calls chart tools without corrupting stdout", async () => {
    const protocolErrors: Error[] = [];
    let stderr = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", MCP_ENTRYPOINT],
      cwd: PROJECT_ROOT,
      env: {
        ...getDefaultEnvironment(),
        MARKET_CHART_PORT: "0",
        MARKET_CHART_SCREENSHOTS: "false",
      },
      stderr: "pipe",
    });
    transport.onerror = (error) => protocolErrors.push(error);
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const client = new Client({ name: "standards-client-test", version: "0.1.0" });
    client.onerror = (error) => protocolErrors.push(error);

    try {
      await client.connect(transport);

      expect(client.getServerVersion()).toMatchObject({
        name: "tradingview-mcp",
        version: "0.4.1",
      });
      expect(client.getInstructions()).toContain("tradingview_get_day");
      expect(client.getInstructions()).toContain("start on demand");

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "market_get_capabilities",
          "chart_get_state",
          "chart_analyze",
          "chart_add_level",
          "chart_apply_overlays",
          "tradingview_get_history",
          "tradingview_analyze_symbol",
          "tradingview_get_day",
          "tradingview_capture_period",
          "tradingview_open_chart",
          "tradingview_export_chart",
          "tradingview_snapshot",
          "tradingview_close",
        ]),
      );

      const historyTool = listed.tools.find((tool) => tool.name === "tradingview_get_history");
      expect(historyTool?.inputSchema).toMatchObject({
        properties: { includeBars: { default: false } },
      });
      const dayTool = listed.tools.find((tool) => tool.name === "tradingview_get_day");
      expect(dayTool?.inputSchema).toMatchObject({
        properties: {
          interval: { default: "D" },
          timezone: { default: "UTC" },
          lookbackBars: { default: 500 },
          includeBars: { default: false },
        },
        required: expect.arrayContaining(["symbol", "date"]),
      });
      const periodTool = listed.tools.find(
        (tool) => tool.name === "tradingview_capture_period",
      );
      expect(periodTool?.inputSchema).toMatchObject({
        properties: {
          interval: { default: "D" },
          chartOnly: { default: true },
          keepBrowserOpen: { default: false },
        },
        required: expect.arrayContaining(["symbol", "from", "to"]),
      });
      expect(historyTool?.inputSchema).toMatchObject({ additionalProperties: false });

      const credentialInjection = await client.callTool({
        name: "tradingview_get_history",
        arguments: {
          symbol: "NASDAQ:AAPL",
          cookie: "must-not-enter-tool-input",
        },
      });
      expect(credentialInjection).toMatchObject({ isError: true });
      expect(JSON.stringify(credentialInjection)).not.toContain("must-not-enter-tool-input");

      const initialCapabilities = structuredContent(
        await client.callTool({ name: "market_get_capabilities", arguments: {} }),
      );
      expect(initialCapabilities).toMatchObject({
        viewer: { started: false, startsOnDemand: true },
        providers: {
          tradingView: {
            startsOnDemand: true,
            authenticationMode: "none",
            credentialPolicy: {
              acceptedThroughMcp: false,
              allowedCookieNames: ["sessionid", "sessionid_sign", "device_t"],
              allowedLocalStorageKeys: [],
            },
          },
        },
      });

      const stateResult = await client.callTool({
        name: "chart_get_state",
        arguments: { includeBars: false },
      });
      expect(stateResult).not.toMatchObject({ isError: true });
      const initialState = structuredContent(stateResult);
      expect(initialState).toMatchObject({
        symbol: "DEMO:MARKET",
        interval: "60",
        source: "synthetic-demo",
        levels: [],
      });
      expect(initialState.barCount).toBeGreaterThanOrEqual(200);

      const localPriceResult = await client.callTool({
        name: "market_get_price",
        arguments: { symbol: "DEMO:MARKET", timeframe: "60", range: 10 },
      });
      expect(structuredContent(localPriceResult)).toMatchObject({ chartUnchanged: true });
      const afterLocalPrice = structuredContent(
        await client.callTool({ name: "chart_get_state", arguments: { includeBars: false } }),
      );
      expect(afterLocalPrice.barCount).toBe(initialState.barCount);
      expect(afterLocalPrice.revision).toBe(initialState.revision);

      const analysisResult = await client.callTool({
        name: "chart_analyze",
        arguments: {},
      });
      expect(analysisResult).not.toMatchObject({ isError: true });
      const analysis = structuredContent(analysisResult);
      expect(analysis).toMatchObject({
        barsAnalyzed: initialState.barCount,
      });
      expect(analysis.summary).toEqual(expect.any(String));
      expect(analysis.trend).toEqual(
        expect.objectContaining({
          direction: expect.stringMatching(/^(bullish|bearish|sideways)$/),
          score: expect.any(Number),
        }),
      );

      const levelResult = await client.callTool({
        name: "chart_add_level",
        arguments: {
          id: "mcp-smoke-support",
          price: 100.25,
          label: "MCP smoke support",
          color: "#22c55e",
        },
      });
      expect(levelResult).not.toMatchObject({ isError: true });
      expect(structuredContent(levelResult)).toEqual({
        id: "mcp-smoke-support",
        price: 100.25,
        label: "MCP smoke support",
        color: "#22c55e",
      });

      const updatedResult = await client.callTool({
        name: "chart_get_state",
        arguments: { includeBars: false },
      });
      const updatedState = structuredContent(updatedResult);
      expect(updatedState.levels).toEqual([
        {
          id: "mcp-smoke-support",
          price: 100.25,
          label: "MCP smoke support",
          color: "#22c55e",
        },
      ]);
      expect(updatedState.revision).toBeGreaterThan(initialState.revision as number);

      const overlayResult = await client.callTool({
        name: "chart_apply_overlays",
        arguments: {
          replace: true,
          indicators: [
            {
              id: "roman",
              kind: "bollinger",
              period: 25,
              standardDeviations: 1,
              color: "#ef4444",
            },
          ],
          levels: [{ id: "pain", price: 101, label: "Max Pain", color: "#a78bfa" }],
          customSeries: [
            {
              id: "scenario",
              kind: "line",
              label: "Base scenario",
              pane: "price",
              color: "#f59e0b",
              lineWidth: 2,
              lineStyle: "dashed",
              data: [
                { time: 1_735_776_000, value: 100 },
                { time: 1_735_779_600, value: 102 },
              ],
            },
          ],
        },
      });
      expect(structuredContent(overlayResult)).toMatchObject({
        overlayCounts: {
          indicators: 1,
          levels: 1,
          customSeries: 1,
          zones: 0,
          markers: 0,
        },
      });

      const opened = structuredContent(
        await client.callTool({ name: "chart_open", arguments: {} }),
      );
      expect(opened.viewerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(
        structuredContent(
          await client.callTool({ name: "market_get_capabilities", arguments: {} }),
        ),
      ).toMatchObject({ viewer: { started: true, startsOnDemand: true } });

      // StdioClientTransport reports any non-JSON-RPC stdout line through onerror.
      await setImmediate();
    } finally {
      await client.close();
    }

    expect(protocolErrors).toEqual([]);
    expect(stderr).toMatch(/tradingview-mcp ready; viewer and TradingView browser start on demand/);
  }, 20_000);

  it("shuts down its HTTP runtime and exits on SIGINT", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRYPOINT], {
      cwd: PROJECT_ROOT,
      env: {
        ...getDefaultEnvironment(),
        MARKET_CHART_PORT: "0",
        MARKET_CHART_SCREENSHOTS: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    const ready = new Promise<void>((resolve) => {
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
        if (/tradingview-mcp ready; viewer and TradingView browser start on demand/.test(stderr)) {
          resolve();
        }
      });
    });

    try {
      await withTimeout(ready, 5_000, "MCP process did not become ready.");
      expect(child.kill("SIGINT")).toBe(true);
      const [code, signal] = await withTimeout(
        once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
        3_000,
        "MCP process did not exit after SIGINT.",
      );
      expect(code).toBe(0);
      expect(signal).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
});

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(message);
    }),
  ]);
}
