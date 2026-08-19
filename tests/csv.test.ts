import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadBarsFromCsv, parseBarsCsv } from "../src/csv.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "market-chart-csv-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseBarsCsv", () => {
  it("normalizes case and whitespace in headers and parses OHLCV values", () => {
    const bars = parseBarsCsv(
      "\ufeff Time , OPEN ,High,Low,Close, Volume\n" +
        "2024-01-01T00:00:00Z,10,12,9,11,100\n" +
        "2024-01-02T00:00:00Z,11,13,10,12,200\n",
    );

    expect(bars).toEqual([
      { time: 1_704_067_200, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: 1_704_153_600, open: 11, high: 13, low: 10, close: 12, volume: 200 },
    ]);
  });

  it("accepts newest-first CSV data by reversing the complete series", () => {
    const bars = parseBarsCsv(
      "time,open,high,low,close\n" +
        "1700000060,11,13,10,12\n" +
        "1700000000,10,12,9,11\n",
    );

    expect(bars.map((bar) => bar.time)).toEqual([1_700_000_000, 1_700_000_060]);
  });

  it("can retain only the newest bars for large official exports", () => {
    const rows = Array.from(
      { length: 10_005 },
      (_, index) => `${1_700_000_000 + index * 60},10,12,9,11`,
    );
    const bars = parseBarsCsv(`time,open,high,low,close\n${rows.join("\n")}\n`, {
      tailBars: 10_000,
    });

    expect(bars).toHaveLength(10_000);
    expect(bars[0]!.time).toBe(1_700_000_000 + 5 * 60);
  });

  it("rejects empty, unordered, and malformed rows", () => {
    expect(() => parseBarsCsv("time,open,high,low,close\n")).toThrow(/no data rows/i);
    expect(() =>
      parseBarsCsv(
        "time,open,high,low,close\n" +
          "1700000000,10,12,9,11\n" +
          "1700000120,11,13,10,12\n" +
          "1700000060,12,14,11,13\n",
      ),
    ).toThrow(/strictly later/i);
    expect(() => parseBarsCsv("time,open,high,low,close\n1700000000,10,nope,9,11\n")).toThrow(
      /high must be a finite number/i,
    );
  });
});

describe("loadBarsFromCsv", () => {
  it("loads relative and absolute files that resolve inside the configured data root", async () => {
    const root = await temporaryDirectory();
    const nested = path.join(root, "nested");
    const csvPath = path.join(nested, "bars.csv");
    await mkdir(nested);
    await writeFile(csvPath, "time,open,high,low,close\n1700000000,10,12,9,11\n", "utf8");

    const relative = await loadBarsFromCsv("nested/bars.csv", root);
    const absolute = await loadBarsFromCsv(csvPath, root);

    expect(relative).toEqual(absolute);
    expect(relative.path).toBe(csvPath);
    expect(relative.bars).toHaveLength(1);
  });

  it("blocks parent-directory traversal, absolute paths outside the root, and escaping symlinks", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "data");
    const outside = path.join(parent, "outside.csv");
    await mkdir(root);
    await writeFile(outside, "time,open,high,low,close\n1700000000,10,12,9,11\n", "utf8");
    await symlink(outside, path.join(root, "linked.csv"));

    await expect(loadBarsFromCsv("../outside.csv", root)).rejects.toThrow(/must resolve inside/i);
    await expect(loadBarsFromCsv(outside, root)).rejects.toThrow(/must resolve inside/i);
    await expect(loadBarsFromCsv("linked.csv", root)).rejects.toThrow(/must resolve inside/i);
  });

  it("rejects nonexistent roots, directories, and missing files", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "data");
    await mkdir(root);

    await expect(loadBarsFromCsv("bars.csv", path.join(parent, "missing-root"))).rejects.toThrow(
      /data root does not exist/i,
    );
    await expect(loadBarsFromCsv("missing.csv", root)).rejects.toThrow(/file does not exist/i);
    await expect(loadBarsFromCsv(".", root)).rejects.toThrow(/regular file/i);
  });
});
