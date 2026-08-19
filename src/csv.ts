import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type { Bar } from "./domain.js";
import { MAX_BARS, normalizeBar, validateBars } from "./domain.js";

const MAX_CSV_BYTES = 5 * 1024 * 1024;

interface CsvLoadOptions {
  maximumBytes?: number | undefined;
  tailBars?: number | undefined;
}

export interface CsvBarWithFields {
  bar: Bar;
  fields: Record<string, string | number | null>;
}

export async function loadBarsFromCsv(
  requestedPath: string,
  dataRoot: string,
  options: CsvLoadOptions = {},
): Promise<{
  bars: Bar[];
  path: string;
  sourceBarCount: number;
  truncated: boolean;
}> {
  const root = await realpath(dataRoot).catch(() => {
    throw new Error(`CSV data root does not exist: ${dataRoot}`);
  });
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(root, requestedPath);
  const resolved = await realpath(candidate).catch(() => {
    throw new Error(`CSV file does not exist: ${requestedPath}`);
  });
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`CSV file must resolve inside MARKET_CHART_DATA_ROOT (${root}).`);
  }
  const details = await stat(resolved);
  if (!details.isFile()) {
    throw new Error("CSV path must point to a regular file.");
  }
  const maximumBytes = options.maximumBytes ?? MAX_CSV_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("CSV maximumBytes must be a positive safe integer.");
  }
  if (details.size > maximumBytes) {
    throw new Error(`CSV file exceeds the ${maximumBytes}-byte limit.`);
  }
  const source = await readFile(resolved, "utf8");
  const parsed = parseBarsCsvDetailed(source, options.tailBars);
  return { ...parsed, path: resolved };
}

export async function loadBarsWithFieldsFromCsv(
  requestedPath: string,
  dataRoot: string,
  options: CsvLoadOptions = {},
): Promise<{
  bars: Bar[];
  rows: CsvBarWithFields[];
  path: string;
  sourceBarCount: number;
  truncated: boolean;
}> {
  const loaded = await loadBarsFromCsv(requestedPath, dataRoot, options);
  const source = await readFile(loaded.path, "utf8");
  const records = parse(source, {
    columns: uniqueNormalizedHeaders,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    max_record_size: 1_000_000,
  }) as Array<Record<string, unknown>>;
  let rows = records.map((record) => ({
    bar: normalizeBar(record),
    fields: Object.fromEntries(
      Object.entries(record)
        .filter(([name]) => !["time", "open", "high", "low", "close", "volume"].includes(name))
        .map(([name, value]) => [name, scalarField(value)]),
    ),
  }));
  if (rows.length >= 2 && rows[0]!.bar.time > rows.at(-1)!.bar.time) rows.reverse();
  if (options.tailBars !== undefined && rows.length > options.tailBars) {
    rows = rows.slice(-options.tailBars);
  }
  if (
    rows.length !== loaded.bars.length ||
    rows.some((row, index) => row.bar.time !== loaded.bars[index]?.time)
  ) {
    throw new Error("CSV field rows do not align with parsed OHLCV bars.");
  }
  return { ...loaded, rows };
}

export function parseBarsCsv(source: string, options: { tailBars?: number } = {}): Bar[] {
  return parseBarsCsvDetailed(source, options.tailBars).bars;
}

function parseBarsCsvDetailed(
  source: string,
  tailBars: number | undefined,
): { bars: Bar[]; sourceBarCount: number; truncated: boolean } {
  if (tailBars !== undefined && (!Number.isSafeInteger(tailBars) || tailBars < 1 || tailBars > MAX_BARS)) {
    throw new Error(`CSV tailBars must be an integer from 1 through ${MAX_BARS}.`);
  }
  const records = parse(source, {
    columns: (headers: string[]) => headers.map((header) => header.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    max_record_size: 1_000_000,
  }) as Array<Record<string, unknown>>;
  if (records.length === 0) {
    throw new Error("CSV contains no data rows.");
  }
  if (records.length > MAX_BARS && tailBars === undefined) {
    throw new Error(`CSV contains more than ${MAX_BARS} bars.`);
  }
  let bars = records.map((record) => normalizeBar(record));
  if (bars.length >= 2 && bars[0]!.time > bars.at(-1)!.time) {
    bars.reverse();
  }
  const sourceBarCount = bars.length;
  if (tailBars !== undefined && bars.length > tailBars) {
    bars = bars.slice(-tailBars);
  }
  validateBars(bars);
  return { bars, sourceBarCount, truncated: sourceBarCount !== bars.length };
}

function uniqueNormalizedHeaders(headers: string[]): string[] {
  const counts = new Map<string, number>();
  return headers.map((header, index) => {
    const base = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `field_${index + 1}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function scalarField(value: unknown): string | number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  const text = String(value).trim();
  if (text === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
}
