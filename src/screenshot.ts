import type { Browser } from "playwright";

export class ScreenshotService {
  #browser: Browser | undefined;

  constructor(private readonly enabled: boolean) {}

  async capture(
    viewerUrl: string,
    options: { width?: number; height?: number; token?: string } = {},
  ): Promise<Buffer> {
    if (!this.enabled) {
      throw new Error("Chart screenshots are disabled by MARKET_CHART_SCREENSHOTS=false.");
    }
    const width = boundedDimension(options.width ?? 1440, "width", 640, 2_400);
    const height = boundedDimension(options.height ?? 900, "height", 480, 1_600);
    const base = new URL(viewerUrl);
    const target = new URL(viewerUrl);
    if (options.token) {
      target.hash = `token=${encodeURIComponent(options.token)}`;
    }

    const browser = await this.#getBrowser();
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      await page.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === base.origin || requestUrl.protocol === "data:") {
          await route.continue();
        } else {
          await route.abort("blockedbyclient");
        }
      });
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.locator('body[data-ready="true"]').waitFor({ state: "attached", timeout: 20_000 });
      return await page.screenshot({ type: "png", fullPage: false });
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser) await browser.close();
  }

  async #getBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    const { chromium } = await import("playwright");
    this.#browser = await chromium.launch({ headless: true });
    return this.#browser;
  }
}

function boundedDimension(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
