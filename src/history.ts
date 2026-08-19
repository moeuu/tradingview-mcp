#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ChartStore } from "./chart-store.js";
import { loadConfig } from "./config.js";
import { DEMO_BARS } from "./demo.js";
import { TradingViewHistoryInputSchema } from "./schemas.js";
import { TradingViewBrowserService } from "./tradingview-browser.js";

interface ParsedHistoryArguments {
  help: boolean;
  pretty: boolean;
  input?: ReturnType<typeof TradingViewHistoryInputSchema.parse> | undefined;
}

export function parseHistoryArguments(args: string[]): ParsedHistoryArguments {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, pretty: args.includes("--pretty") };
  }

  const raw: Record<string, unknown> = { loadChart: false };
  let pretty = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--pretty") {
      pretty = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    switch (argument) {
      case "--symbol":
      case "-s":
        raw.symbol = value;
        break;
      case "--interval":
      case "-i":
        raw.interval = value;
        break;
      case "--bars":
      case "-n":
        raw.bars = Number(value);
        break;
      case "--layout-id":
        raw.layoutId = value;
        break;
      case "--output-name":
        raw.outputName = value;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}.`);
    }
    index += 1;
  }
  return { help: false, pretty, input: TradingViewHistoryInputSchema.parse(raw) };
}

export async function runHistoryCli(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<void> {
  const parsed = parseHistoryArguments(args);
  if (parsed.help) {
    process.stdout.write(historyUsage());
    return;
  }

  const config = loadConfig(env, cwd);
  const store = new ChartStore({
    bars: DEMO_BARS.map((bar) => ({ ...bar })),
    symbol: "DEMO:MARKET",
    interval: "60",
    source: "synthetic-demo",
  });
  const browser = new TradingViewBrowserService(
    config.tradingViewBrowser,
    config.dataRoot,
    store,
  );
  try {
    const history = await browser.getHistory(parsed.input!);
    process.stdout.write(`${JSON.stringify(history, null, parsed.pretty ? 2 : undefined)}\n`);
  } finally {
    await browser.close();
  }
}

function historyUsage(): string {
  return [
    "Usage: market-chart-history --symbol <EXCHANGE:TICKER> [options]",
    "",
    "Options:",
    "  -s, --symbol <symbol>       TradingView symbol (required)",
    "  -i, --interval <interval>   Interval such as 1, 240, D, W, or M (default: D)",
    "  -n, --bars <count>          Most-recent bars to return, 1-10000 (default: 1000)",
    "      --layout-id <id>        Optional saved TradingView layout id",
    "      --output-name <file>    Optional simple .csv archive filename",
    "      --pretty                Pretty-print JSON",
    "  -h, --help                  Show this help",
    "",
  ].join("\n");
}

function isEntrypoint(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isEntrypoint()) {
  runHistoryCli().catch((error: unknown) => {
    console.error(
      `TradingView history failed: ${error instanceof Error ? error.message : "Request failed."}`,
    );
    process.exitCode = 1;
  });
}
