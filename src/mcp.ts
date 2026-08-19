#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRuntime } from "./runtime.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS =
  "Use market_get_capabilities when provider availability is unclear. Use tradingview_get_day for a symbol on a specific historical date and tradingview_capture_period for a date-range screenshot. Prefer tradingview_analyze_symbol for recent official history plus deterministic analysis; use tradingview_get_history for history only. Viewer and browsers start on demand. High-level TradingView tools close the browser by default; call tradingview_close after interactive work. Report source, interval, timezone, authentication, and delayed status. Data may be delayed or inaccurate; this is not investment advice.";

export async function startMcpServer(): Promise<void> {
  const runtime = await createRuntime();
  const server = new McpServer(
    { name: "tradingview-mcp", version: "0.4.0" },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  registerTools(server, runtime);

  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  server.server.onerror = (error) => console.error("MCP protocol error:", error);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      await Promise.allSettled([server.close(), runtime.close()]);
    })();
    return shutdownPromise;
  };
  const onSignal = () => void shutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  console.error("tradingview-mcp ready; viewer and TradingView browser start on demand");
  try {
    await server.connect(transport);
    await closed;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await shutdown();
  }
}

function isEntrypoint(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isEntrypoint()) {
  startMcpServer().catch((error: unknown) => {
    console.error("Failed to start tradingview-mcp:", error);
    process.exitCode = 1;
  });
}
