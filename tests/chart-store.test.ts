import { describe, expect, it } from "vitest";

import { ChartStore } from "../src/chart-store.js";
import type { Bar } from "../src/domain.js";

const initialBars: Bar[] = [
  { time: 1_700_000_000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { time: 1_700_000_060, open: 11, high: 13, low: 10, close: 12, volume: 120 },
];

describe("ChartStore atomic updates", () => {
  it("does not partially replace bars when metadata validation fails", () => {
    const store = new ChartStore({
      bars: initialBars,
      symbol: "LOCAL:ONE",
      interval: "60",
      source: "fixture",
    });
    const before = store.getState();

    expect(() =>
      store.setBars({
        bars: [{ time: 1_800_000_000, open: 20, high: 22, low: 19, close: 21 }],
        symbol: "bad symbol!",
        interval: "60",
        source: "replacement",
      }),
    ).toThrow(/invalid symbol/i);
    expect(store.getState()).toEqual(before);
  });

  it("validates an entire view update before changing any field", () => {
    const store = new ChartStore({ bars: initialBars, symbol: "LOCAL:ONE", interval: "60" });
    const before = store.getState();

    expect(() => store.setView({ symbol: "LOCAL:TWO", interval: "bad interval" })).toThrow(
      /invalid interval/i,
    );
    expect(store.getState()).toEqual(before);
  });

  it("accepts continuous-futures symbols used by TradingView exports", () => {
    const store = new ChartStore({ bars: initialBars });
    const state = store.setBars({
      bars: initialBars,
      symbol: "CME:NKD1!",
      interval: "240",
      source: "TradingView export",
    });

    expect(state.symbol).toBe("CME:NKD1!");
  });

  it("applies a complete Nikkei overlay bundle atomically", () => {
    const store = new ChartStore({ bars: initialBars, symbol: "CME:NKD1!", interval: "240" });

    const state = store.applyOverlayBundle({
      replace: true,
      indicators: [
        { id: "roman", kind: "bollinger", period: 25, standardDeviations: 1, color: "#ef4444" },
      ],
      levels: [{ id: "max-pain", price: 11_500, label: "Max Pain", color: "#a78bfa" }],
      customSeries: [
        {
          id: "cvd",
          kind: "histogram",
          label: "CVD",
          pane: "cvd",
          color: "#38bdf8",
          lineWidth: 2,
          lineStyle: "solid",
          data: [
            { time: 1_700_000_000, value: -50 },
            { time: 1_700_000_060, value: 25 },
          ],
        },
      ],
      zones: [
        {
          id: "demand",
          startTime: 1_700_000_000,
          endTime: 1_700_000_120,
          upper: 11,
          lower: 10,
          label: "Demand",
          color: "#22c55e",
        },
      ],
      markers: [
        {
          id: "sq",
          time: 1_700_000_060,
          position: "aboveBar",
          shape: "circle",
          color: "#f8fafc",
          text: "SQ",
        },
      ],
    });

    expect(state.indicators).toHaveLength(1);
    expect(state.levels).toHaveLength(1);
    expect(state.customSeries[0]).toMatchObject({ id: "cvd", pane: "cvd" });
    expect(state.zones[0]).toMatchObject({ id: "demand", upper: 11, lower: 10 });
    expect(state.markers[0]).toMatchObject({ id: "sq", text: "SQ" });
  });

  it("does not partially apply an invalid overlay bundle", () => {
    const store = new ChartStore({ bars: initialBars, symbol: "CME:NKD1!", interval: "240" });
    const before = store.getState();

    expect(() =>
      store.applyOverlayBundle({
        replace: true,
        levels: [{ id: "valid", price: 11, label: "Valid", color: "#22c55e" }],
        zones: [
          {
            id: "invalid",
            startTime: 1_700_000_120,
            endTime: 1_700_000_000,
            upper: 12,
            lower: 10,
            label: "Invalid",
            color: "#ef4444",
          },
        ],
      }),
    ).toThrow(/endTime/i);
    expect(store.getState()).toEqual(before);
  });
});
