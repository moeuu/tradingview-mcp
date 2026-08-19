import { afterEach, describe, expect, it, vi } from "vitest";

import { TradingViewDataClient } from "../src/rapidapi.js";

afterEach(() => vi.unstubAllGlobals());

describe("TradingViewDataClient response limits", () => {
  it("cancels a chunked response as soon as its decoded body exceeds 10 MB", async () => {
    let cancelled = false;
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(6 * 1024 * 1024));
        if (emitted >= 3) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const client = new TradingViewDataClient(
      "test-key",
      "tradingview-data1.p.rapidapi.com",
    );
    await expect(client.get("/api/news")).rejects.toThrow(/exceeded the size limit/i);
    expect(cancelled).toBe(true);
  });
});
