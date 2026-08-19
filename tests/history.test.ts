import { describe, expect, it } from "vitest";
import { parseHistoryArguments } from "../src/history.js";

describe("TradingView history CLI arguments", () => {
  it.each([
    ["TSE:8697", "D"],
    ["OSE:NK2251!", "D"],
    ["OSE:NK2251!", "W"],
    ["OSE:NK2251!", "M"],
    ["OSE:NK225U2026", "1"],
    ["OSE:NK225M1!", "240"],
  ])("accepts %s at interval %s", (symbol, interval) => {
    const parsed = parseHistoryArguments([
      "--symbol",
      symbol,
      "--interval",
      interval,
      "--bars",
      "750",
    ]);

    expect(parsed.input).toEqual({
      symbol,
      interval,
      bars: 750,
      loadChart: false,
    });
  });

  it("applies safe defaults and rejects paths as archive names", () => {
    expect(parseHistoryArguments(["--symbol", "TSE:8697"]).input).toEqual({
      symbol: "TSE:8697",
      interval: "D",
      bars: 1_000,
      loadChart: false,
    });
    expect(() =>
      parseHistoryArguments([
        "--symbol",
        "TSE:8697",
        "--output-name",
        "../outside.csv",
      ]),
    ).toThrow();
  });

  it("rejects unknown flags and out-of-range bar counts", () => {
    expect(() => parseHistoryArguments(["--symbol", "TSE:8697", "--unknown", "x"])).toThrow(
      "Unknown argument",
    );
    expect(() =>
      parseHistoryArguments(["--symbol", "TSE:8697", "--bars", "10001"]),
    ).toThrow();
  });
});
