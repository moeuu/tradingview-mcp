import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChartStore } from "../src/chart-store.js";
import type { AppConfig } from "../src/config.js";
import type { TradingViewCaptureBatchInput } from "../src/schemas.js";
import {
  type TradingViewCaptureDomObservation,
  type TradingViewCaptureDriver,
  PlaywrightTradingViewCaptureDriver,
  TradingViewBrowserService,
  cloneTradingViewStorageState,
  computeTradingViewCaptureManifestIdentity,
  createIsolatedTradingViewCaptureContext,
  loadCurrentTradingViewCaptureManifest,
  loadTradingViewCookies,
  loadTradingViewStorageState,
} from "../src/tradingview-browser.js";

describe("TradingView authentication input", () => {
  it("filters non-TradingView cookies and origins from storage state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tv-storage-state-"));
    const file = path.join(directory, "state.json");
    await writeFile(
      file,
      JSON.stringify({
        cookies: [
          cookie("sessionid", "tv", ".tradingview.com"),
          cookie("SID", "other", ".google.com"),
        ],
        origins: [
          {
            origin: "https://www.tradingview.com",
            localStorage: [{ name: "chart", value: "saved" }],
          },
          {
            origin: "https://accounts.google.com",
            localStorage: [{ name: "token", value: "other" }],
          },
        ],
      }),
      "utf8",
    );

    const state = await loadTradingViewStorageState(file);

    expect(state.cookies.map((item) => item.name)).toEqual(["sessionid"]);
    expect(state.origins.map((item) => item.origin)).toEqual([
      "https://www.tradingview.com",
    ]);
  });

  it("filters JSON cookie exports with the same domain boundary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tv-cookie-file-"));
    const file = path.join(directory, "cookies.json");
    await writeFile(
      file,
      JSON.stringify({
        cookies: [
          cookie("sessionid", "tv", "jp.tradingview.com"),
          cookie("foreign_session", "other", ".note.com"),
        ],
      }),
      "utf8",
    );

    const cookies = await loadTradingViewCookies(file);

    expect(cookies.map((item) => item.name)).toEqual(["sessionid"]);
  });

  it("clones auth state in memory and creates disposable service-worker-blocked contexts", async () => {
    const source = {
      cookies: [cookie("sessionid", "test-session", ".tradingview.com")],
      origins: [
        {
          origin: "https://jp.tradingview.com",
          localStorage: [{ name: "auth-marker", value: "present" }],
        },
      ],
    };
    const cloned = cloneTradingViewStorageState(source);
    cloned.cookies[0]!.value = "changed";
    cloned.origins[0]!.localStorage[0]!.value = "changed";
    expect(source.cookies[0]!.value).toBe("test-session");
    expect(source.origins[0]!.localStorage[0]!.value).toBe("present");

    let serviceWorkerScriptRequested = false;
    const server = createServer((request, response) => {
      if (request.url === "/sw.js") {
        serviceWorkerScriptRequested = true;
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("self.addEventListener('fetch', () => undefined);");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>isolated context probe</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const browser = await chromium.launch({ headless: true });
    const first = await createIsolatedTradingViewCaptureContext(browser, source);
    const second = await createIsolatedTradingViewCaptureContext(browser, source);
    try {
      expect(first).not.toBe(second);
      await first.clearCookies();
      expect((await second.cookies()).map((item) => item.name)).toContain("sessionid");
      const page = await first.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.evaluate(async () => {
        try {
          await navigator.serviceWorker.register("/sw.js");
        } catch {
          // A blocked context may reject immediately or return an inert registration.
        }
      });
      await page.waitForTimeout(100);
      expect(first.serviceWorkers()).toEqual([]);
      expect(serviceWorkerScriptRequested).toBe(false);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("production Playwright capture guard", () => {
  it("detects upgrade/trial/purchase/payment surfaces in banners, popovers, menus, and iframes", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const cases = [
        '<div role="banner">Upgrade your plan</div>',
        '<div role="menu">Start a free trial</div>',
        '<div id="offer" popover="manual">Payment required</div><script>offer.showPopover()</script>',
        '<iframe srcdoc="<div>Purchase subscription</div>"></iframe>',
      ];
      for (const html of cases) {
        await page.setContent(html);
        if (html.includes("iframe")) {
          await page.frames()[1]!.locator("body").waitFor();
        }
        const driver = new PlaywrightTradingViewCaptureDriver(page);
        await expect(driver.assertNoForbiddenDialog("adversarial surface")).rejects.toThrow(
          /surface is visible in a page frame/i,
        );
      }
    } finally {
      await browser.close();
    }
  });

  it("does not accept document-global controls as chart-scoped evidence", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <button data-name="header-chart-type">Candlesticks</button>
        <button data-name="timezone">Asia/Tokyo</button>
        <button data-name="session">OSE full day and night session</button>
        <main class="layout__area--center">
          <div role="region" aria-label="Chart for OSE:NK2251!" style="width:400px;height:300px"></div>
          <canvas aria-label="OSE_DLY:NK2251! 5 minute chart" width="400" height="300"></canvas>
          <a href="https://jp.tradingview.com/symbols/OSE-NK2251!/">Nikkei 225 Futures</a>
        </main>
      `);
      const observed = await new PlaywrightTradingViewCaptureDriver(page).observe("5", undefined);
      expect(observed).toMatchObject({
        chartCount: 1,
        chartAuditComplete: true,
        chartTypeLabel: null,
        timezoneLabel: null,
        sessionLabel: null,
      });
    } finally {
      await browser.close();
    }
  });

  it("enumerates comparison, drawing, and study surfaces from the loaded Object Tree", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <main class="layout__area--center">
          <div role="region" aria-label="Chart for OSE:NK2251!" style="width:400px;height:300px"></div>
          <canvas aria-label="OSE_DLY:NK2251! 5 minute chart" width="400" height="300"></canvas>
          <a href="https://jp.tradingview.com/symbols/OSE-NK2251!/">Nikkei 225 Futures</a>
          <section data-name="legend">
            <div data-name="legend-source-item" data-symbol="OSE:NK2251!">OSE:NK2251!</div>
            <div data-name="legend-source-item" data-symbol="CME:ES1!">CME:ES1!</div>
            <div data-study-id="STD;Ichimoku Cloud" style="display:none">Ichimoku Cloud</div>
          </section>
          <section data-name="tree">Object Tree
            <div class="listContainer-fixture"><div>
              <div data-symbol="OSE:NK2251!">NK2251! · OSE</div>
              <div data-symbol="CME:ES1!">ES1! · CME</div>
              <div data-study-id="STD;Ichimoku Cloud" data-study-name="Ichimoku Cloud">Ichimoku Cloud</div>
              <div data-drawing-id="line-1" data-name="drawing">Trend Line</div>
            </div></div>
          </section>
        </main>
      `);
      const observed = await new PlaywrightTradingViewCaptureDriver(page).observe("5", undefined);
      expect(observed).toMatchObject({
        chartCount: 1,
        collapsedStudyCount: 0,
        comparisonAuditComplete: true,
        drawingAuditComplete: true,
      });
      expect(observed.comparisons).toHaveLength(1);
      expect(observed.studies).toHaveLength(1);
      expect(observed.drawings).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  it("does not treat an Object Tree shell or an omitted hidden study as a complete empty audit", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <main class="layout__area--center">
          <div role="region" aria-label="Chart for OSE:NK2251!" style="width:400px;height:300px"></div>
          <canvas aria-label="OSE_DLY:NK2251! 5 minute chart" width="400" height="300"></canvas>
          <section data-name="legend">
            <div data-name="legend-source-item" data-symbol="OSE:NK2251!">OSE:NK2251!</div>
            <div data-study-id="STD;Ichimoku Cloud" style="display:none">Ichimoku Cloud</div>
          </section>
          <section data-name="object-tree-content">Object Tree shell only</section>
        </main>
      `);
      const shellOnly = await new PlaywrightTradingViewCaptureDriver(page).observe("5", undefined);
      expect(shellOnly.objectTreeAuditComplete).toBe(false);
      expect(shellOnly.drawingAuditComplete).toBe(false);

      await page.locator('[data-name="object-tree-content"]').evaluate((element) => {
        element.setAttribute("data-name", "tree");
        element.innerHTML =
          '<div class="listContainer-fixture"><div><div data-symbol="OSE:NK2251!">NK2251! · OSE</div></div></div>';
      });
      const omittedStudy = await new PlaywrightTradingViewCaptureDriver(page).observe("5", undefined);
      expect(omittedStudy.objectTreeAuditComplete).toBe(true);
      expect(omittedStudy.collapsedStudyCount).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it("requires separately rendered price and time axes instead of inferring axes from canvas count", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <main class="layout__area--center">
          <div role="region" aria-label="Chart for OSE:NK2251!" style="width:400px;height:300px"></div>
          <div>O 42,000 H 42,100 L 41,900 C 42,050</div>
          <canvas aria-label="OSE_DLY:NK2251! 5 minute chart" width="400" height="300" style="width:400px;height:300px"></canvas>
          <canvas width="400" height="300" style="width:400px;height:300px"></canvas>
        </main>
      `);
      const observed = await new PlaywrightTradingViewCaptureDriver(page).observe("5", undefined);
      expect(observed.visibleCanvasCount).toBe(2);
      expect(observed.axisEvidenceCount).toBe(0);
      expect(observed.renderAuditComplete).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("binds delayed/realtime evidence to the main chart series instead of a watchlist", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div data-qa-id="chart-page-grid-area">
          <main class="layout__area--center">
            <div role="region" aria-label="チャート #1" style="width:400px;height:300px"></div>
            <canvas aria-label="OSE_DLY:NK2251! の 5 分 チャート" width="400" height="300"></canvas>
            <a href="https://jp.tradingview.com/symbols/OSE-NK2251!/">Nikkei 225 Futures</a>
            <div data-qa-id="legend-series-item">
              <button data-qa-id="legend-source-item-status" title="市場オープン · 遅延データ"></button>
            </div>
          </main>
          <aside data-tooltip="OANDA · リアルタイム">watchlist quote</aside>
        </div>
      `);
      const observed = await new PlaywrightTradingViewCaptureDriver(page).observe("5", undefined);
      expect(observed).toMatchObject({
        delayedLabelVisible: true,
        realtimeLabel: expect.stringMatching(/遅延データ/),
        realtimeActive: false,
        realtimeSelector: "main-series market-data status control",
      });
    } finally {
      await browser.close();
    }
  });

  it("opens Object Tree, settings, and timezone UI before accepting local audit evidence", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1_800, height: 850 } });
      await page.setContent(`
        <button data-name="object-tree-button" aria-label="Object Tree">Object Tree</button>
        <button data-name="chart-properties-button" aria-label="Chart settings">Settings</button>
        <button data-name="time-zone-menu" aria-label="Timezone">UTC+9</button>
        <button data-name="session-menu" aria-label="Session">Full</button>
        <main class="layout__area--center">
          <div role="region" aria-label="Chart for OSE:NK2251!" style="width:1200px;height:600px"></div>
          <a href="https://jp.tradingview.com/symbols/OSE-NK2251!/">Nikkei 225 Futures</a>
          <button data-name="header-intervals-button">5 minutes</button>
          <button data-name="header-chart-type">Candlesticks</button>
          <section data-name="legend">
            <div data-name="legend-source-item" data-symbol="OSE:NK2251!">OSE:NK2251! O 42,000 H 42,100 L 41,900 C 42,050</div>
          </section>
          <canvas aria-label="OSE_DLY:NK2251! 5 minute chart" width="1200" height="600" style="width:1200px;height:600px"></canvas>
          <canvas width="1200" height="600" style="width:1200px;height:600px"></canvas>
          <div class="price-axis" style="width:60px;height:600px"><canvas width="60" height="600" style="width:60px;height:600px"></canvas></div>
          <div class="time-axis" style="width:1200px;height:30px"><canvas width="1200" height="30" style="width:1200px;height:30px"></canvas></div>
        </main>
        <section data-name="tree" style="display:none">Object Tree
          <div class="listContainer-fixture"><div>
            <div data-symbol="OSE:NK2251!">NK2251! · OSE</div>
          </div></div>
        </section>
        <div role="dialog" style="display:none">Settings
          <button role="tab">Symbol</button>
          <label>Back adjustment <input type="checkbox"></label>
          <label>Use settlement as close <input type="checkbox"></label>
        </div>
        <div data-codex-timezone-menu style="display:none">
          <span aria-checked="true">(UTC+9) Tokyo</span>
        </div>
        <div data-codex-session-menu style="display:none">
          <div data-selected="true">OSE full day and night session</div>
          <span>Day session trading hours</span>
          <span>Night session trading hours</span>
        </div>
        <script>
          const tree = document.querySelector('[data-name="tree"]');
          const settings = document.querySelector('[role="dialog"]');
          const timezone = document.querySelector('[data-codex-timezone-menu]');
          const session = document.querySelector('[data-codex-session-menu]');
          document.querySelector('[data-name="object-tree-button"]').onclick = () => {
            tree.style.display = tree.style.display === 'none' ? 'block' : 'none';
          };
          document.querySelector('[data-name="chart-properties-button"]').onclick = () => {
            settings.style.display = 'block';
          };
          document.querySelector('[data-name="time-zone-menu"]').onclick = () => {
            timezone.dataset.opened = 'true';
            timezone.style.display = 'block';
          };
          document.querySelector('[data-name="session-menu"]').onclick = () => {
            session.dataset.opened = 'true';
            session.style.display = 'block';
          };
          document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
              settings.style.display = 'none';
              timezone.style.display = 'none';
              session.style.display = 'none';
            }
          });
        </script>
      `);
      const driver = new PlaywrightTradingViewCaptureDriver(page);
      await driver.auditLocalState("5", "candles_only", undefined);
      const observed = await driver.observe("5", undefined);
      expect(observed).toMatchObject({
        settingsAuditComplete: true,
        objectTreeAuditComplete: true,
        timezoneLabel: "(UTC+9) Tokyo",
        sessionLabel: expect.stringMatching(/OSE full day and night/i),
        backAdjustment: { active: false },
        settlementAsClose: { active: false },
        renderAuditComplete: true,
      });
      expect(await page.locator('[data-codex-timezone-menu]').getAttribute('data-opened')).toBe(
        'true',
      );
      expect(await page.locator('[data-codex-session-menu]').getAttribute('data-opened')).toBe(
        'true',
      );
    } finally {
      await browser.close();
    }
  });

  it("blocks and reports state-changing/autosave requests from the disposable page", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const driver = new PlaywrightTradingViewCaptureDriver(page);
      await driver.initializeReadOnly();
      await page.setContent("<main>safe chart shell</main>");
      await page.evaluate(async () => {
        await fetch("https://example.invalid/chart/save", { method: "POST", body: "state" }).catch(
          () => undefined,
        );
      });
      await expect(driver.assertNoForbiddenDialog("after autosave probe")).rejects.toThrow(
        /read-only guard blocked it/i,
      );
    } finally {
      await browser.close();
    }
  });

  it("blocks benign telemetry writes without turning a safe capture into a fatal failure", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const driver = new PlaywrightTradingViewCaptureDriver(page);
      await driver.initializeReadOnly();
      await page.setContent("<main>safe chart shell</main>");
      await page.evaluate(async () => {
        await fetch("https://example.invalid/analytics/collect", {
          method: "POST",
          body: "event=chart_view",
        }).catch(() => undefined);
        await fetch(
          "https://static.tradingview.com/static/bundles/open-upgrade-to-pro-on-load.js",
        ).catch(() => undefined);
      });
      await expect(driver.assertNoForbiddenDialog("after telemetry probe")).resolves.toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  it("blocks commerce requests before send and makes the capture fatal", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const driver = new PlaywrightTradingViewCaptureDriver(page);
      await driver.initializeReadOnly();
      await page.setContent("<main>safe chart shell</main>");
      await page.evaluate(async () => {
        await fetch("https://example.invalid/billing/checkout", {
          method: "POST",
        }).catch(() => undefined);
      });
      await expect(driver.assertNoForbiddenDialog("after commerce probe")).rejects.toThrow(
        /commerce\/upgrade HTTP request.*read-only guard blocked it/i,
      );
    } finally {
      await browser.close();
    }
  });

  it("intercepts chart-save WebSocket frames before the server receives them", async () => {
    const received: string[] = [];
    const upgradedSockets = new Set<Duplex>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>WebSocket guard probe</title>");
    });
    server.on("upgrade", (request, socket) => {
      upgradedSockets.add(socket);
      socket.on("close", () => upgradedSockets.delete(socket));
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (frame) => {
        if (frame.byteLength < 6 || (frame[0]! & 0x0f) !== 1) return;
        const length = frame[1]! & 0x7f;
        if (length >= 126 || frame.byteLength < 6 + length) return;
        const mask = frame.subarray(2, 6);
        const decoded = Buffer.alloc(length);
        for (let index = 0; index < length; index += 1) {
          decoded[index] = frame[6 + index]! ^ mask[index % 4]!;
        }
        received.push(decoded.toString("utf8"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const driver = new PlaywrightTradingViewCaptureDriver(page);
      await driver.initializeReadOnly();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.evaluate(async (url) => {
        const socket = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", () => reject(new Error("websocket failed")), {
            once: true,
          });
        });
        socket.send("quote_create_session");
        socket.send("save_chart");
      }, `ws://127.0.0.1:${address.port}/socket`);
      await page.waitForTimeout(100);
      expect(received).toContain("quote_create_session");
      expect(received).not.toContain("save_chart");
      await expect(driver.assertNoForbiddenDialog("after WebSocket probe")).rejects.toThrow(
        /WebSocket message.*read-only guard blocked it/i,
      );
    } finally {
      await browser.close();
      for (const socket of upgradedSockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("official TradingView atomic capture batch", () => {
  let dataRoot: string;
  let config: AppConfig["tradingViewBrowser"];

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "tv-capture-batch-"));
    config = {
      enabled: true,
      baseUrl: "https://jp.tradingview.com",
      headless: true,
      timeoutMs: 5_000,
      downloadsDir: path.join(dataRoot, "tradingview-exports"),
    };
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("matches the frozen Node/Python identity vector with duplicate-selector evidence", () => {
    const vector = frozenIdentityVector();
    expect(
      vector.panels[0]!.observedBefore.evidence.filter(
        (item) => item.selector === "duplicate-selector",
      ),
    ).toHaveLength(2);
    expect(computeTradingViewCaptureManifestIdentity(vector)).toBe(
      "sha256:89503954496035d75c78004e45382757b2bec36183b49f009edef5e7cf86d98e",
    );
  });

  it("binds every batch and panel timing/skew authority field into manifest identity", () => {
    const baseline = frozenIdentityVector();
    const identity = computeTradingViewCaptureManifestIdentity(baseline);
    const mutations: Array<[
      string,
      (value: ReturnType<typeof frozenIdentityVector>) => void,
    ]> = [
      [
        "batchStartedAt",
        (value) => {
          value.batchStartedAt = "2026-07-16T00:59:58Z";
        },
      ],
      [
        "batchEndedAt",
        (value) => {
          value.batchEndedAt = "2026-07-16T01:00:07Z";
        },
      ],
      [
        "captureSkewMs",
        (value) => {
          value.captureSkewMs = 5_001;
        },
      ],
      [
        "panel.captureStartedAt",
        (value) => {
          value.panels[2]!.captureStartedAt = "2026-07-16T01:00:02.010000Z";
        },
      ],
      [
        "panel.captureEndedAt",
        (value) => {
          value.panels[2]!.captureEndedAt = "2026-07-16T01:00:02.110000Z";
        },
      ],
    ];

    for (const [field, mutate] of mutations) {
      const changed = frozenIdentityVector();
      mutate(changed);
      expect(computeTradingViewCaptureManifestIdentity(changed), field).not.toBe(identity);
    }
  });

  it("captures exact 5/60/240/D/W/M order without interleaving and binds each batch identity", async () => {
    const driver = new FakeCaptureDriver();
    const service = captureService(config, dataRoot, driver);

    const [first, second] = await Promise.all([
      service.captureBatch(candlesOnlyRequest()),
      service.captureBatch(candlesOnlyRequest()),
    ]);

    const navigated = driver.actions
      .filter((action) => action.startsWith("navigate:"))
      .map((action) => new URL(action.slice("navigate:".length)).searchParams.get("interval"));
    expect(navigated).toEqual([
      "5",
      "60",
      "240",
      "D",
      "W",
      "M",
      "5",
      "60",
      "240",
      "D",
      "W",
      "M",
    ]);
    expect(first.intervalOrder).toEqual(["5", "60", "240", "D", "W", "M"]);
    expect(first.panels.map((panel) => panel.requestedInterval)).toEqual(first.intervalOrder);
    expect(first.manifestIdentity).not.toBe(second.manifestIdentity);
    expect(first.batchId).not.toBe(second.batchId);
    expect(first.upgradeAttempted).toBe(false);

    const expectedHash = createHash("sha256").update(VALID_PNG).digest("hex");
    for (const panel of first.panels) {
      expect(panel.png).toMatchObject({
        sha256: expectedHash,
        bytes: VALID_PNG.byteLength,
        width: 1_800,
        height: 850,
      });
      expect(panel.png.path.includes("..")).toBe(false);
      const absolute = path.join(dataRoot, panel.png.path);
      const details = await stat(absolute);
      expect(details.isFile()).toBe(true);
      expect(details.nlink).toBe(1);
      expect(await readFile(absolute)).toEqual(VALID_PNG);
    }
    const current = JSON.parse(
      await readFile(path.join(dataRoot, "tradingview-captures", "CURRENT"), "utf8"),
    ) as { batchId: string; manifestIdentity: string };
    expect(current).toMatchObject({
      batchId: second.batchId,
      manifestIdentity: second.manifestIdentity,
    });
    expect((await loadCurrentTradingViewCaptureManifest(dataRoot)).batchId).toBe(second.batchId);
  });

  it("uses and disposes an isolated capture-page lease without touching a shared driver", async () => {
    const sharedDriver = new FakeCaptureDriver();
    const isolatedDriver = new FakeCaptureDriver();
    let disposed = false;
    const service = new TradingViewBrowserService(
      config,
      dataRoot,
      testStore(),
      undefined,
      async () => ({
        driver: isolatedDriver,
        dispose: async () => {
          disposed = true;
        },
      }),
    );

    await service.captureBatch(candlesOnlyRequest());

    expect(disposed).toBe(true);
    expect(sharedDriver.actions).toEqual([]);
    expect(isolatedDriver.actions.filter((action) => action.startsWith("navigate:"))).toHaveLength(6);
  });

  it("rejects stale cached interval state instead of accepting the requested URL", async () => {
    const driver = new FakeCaptureDriver({
      observation: (interval) =>
        ({
          ...domObservation(interval === "60" ? "5" : interval, undefined),
          pageUrl: testCaptureUrl(interval),
        }),
    });
    const service = captureService(config, dataRoot, driver);

    await expect(service.captureBatch(candlesOnlyRequest())).rejects.toThrow(
      /selected UI interval is 5/i,
    );
    expect(driver.screenshotCount).toBe(1);
    await expectCaptureRootEmpty(dataRoot);
  });

  it.each([
    {
      name: "wrong symbol/exchange",
      mutate: (observation: TradingViewCaptureDomObservation) => ({
        ...observation,
        chartAriaLabel: "Chart for CME:NKD1!",
      }),
      message: /exact OSE:NK2251!/i,
    },
    {
      name: "symbol prefix collision",
      mutate: (observation: TradingViewCaptureDomObservation) => ({
        ...observation,
        chartAriaLabel: "Chart for OSE:NK2251!EVIL",
      }),
      message: /exact OSE:NK2251!/i,
    },
    {
      name: "non-standard chart type",
      mutate: (observation: TradingViewCaptureDomObservation) => ({
        ...observation,
        chartTypeLabel: "Heikin Ashi",
      }),
      message: /standard candlesticks/i,
    },
  ])("fails closed for $name DOM mismatch", async ({ mutate, message }) => {
    const driver = new FakeCaptureDriver({
      observation: (interval) => mutate(domObservation(interval, undefined)),
    });
    const service = captureService(config, dataRoot, driver);

    await expect(service.captureBatch(candlesOnlyRequest())).rejects.toThrow(message);
    expect(driver.screenshotCount).toBe(0);
    await expectCaptureRootEmpty(dataRoot);
  });

  it("rejects overlay-mode mismatch and unknown settings", async () => {
    for (const [request, message] of [
      [pineRequest(), /exact saved_layout_pine indicator/i],
      [builtinRequest(), /exact builtin_ichimoku_only indicator/i],
    ] as const) {
      const candlesOnlyDom = new FakeCaptureDriver({
        observation: (interval) => domObservation(interval, undefined),
      });
      await expect(
        captureService(config, dataRoot, candlesOnlyDom).captureBatch(request),
      ).rejects.toThrow(message);
      await expectCaptureRootEmpty(dataRoot);
    }

    const unknownBackAdjustment = new FakeCaptureDriver({
      observation: (interval) => ({
        ...domObservation(interval, undefined),
        backAdjustment: {
          selector: "explicit back-adjustment control",
          label: "Back adjustment",
          active: null,
        },
      }),
    });
    await expect(
      captureService(config, dataRoot, unknownBackAdjustment).captureBatch(candlesOnlyRequest()),
    ).rejects.toThrow(/back adjustment state is unknown/i);
    await expectCaptureRootEmpty(dataRoot);

    const unknownOverlayInventory = new FakeCaptureDriver({
      observation: (interval) => ({
        ...domObservation(interval, undefined),
        studyAuditSelector: null,
        studyAuditComplete: false,
      }),
    });
    await expect(
      captureService(config, dataRoot, unknownOverlayInventory).captureBatch(candlesOnlyRequest()),
    ).rejects.toThrow(/overlay inventory is unknown/i);
    await expectCaptureRootEmpty(dataRoot);
  });

  it("accepts exact DOM-proven Pine and built-in Ichimoku identities", async () => {
    const pine = await captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(
      pineRequest(),
    );
    expect(pine.panels[0]!.observedBefore).toMatchObject({
      overlayMode: "saved_layout_pine",
      indicator: { source: "pine", identity: "PUB;author/script", name: "Manager Ichimoku" },
    });

    const builtinDriver = new FakeCaptureDriver({
      observation: (interval, expected) => {
        const observation = domObservation(interval, expected);
        return {
          ...observation,
          studies: observation.studies.map((study) => ({ ...study, source: "builtin" as const })),
        };
      },
    });
    const builtin = await captureService(config, dataRoot, builtinDriver).captureBatch(
      builtinRequest(),
    );
    expect(builtin.panels[0]!.observedBefore).toMatchObject({
      overlayMode: "builtin_ichimoku_only",
      indicator: {
        source: "builtin",
        identity: "STD;Ichimoku Cloud",
        name: "Ichimoku Cloud",
      },
    });
  });

  it("rejects indicator identity/name substrings and duplicate exact studies", async () => {
    const suffix = new FakeCaptureDriver({
      observation: (interval, expected) => ({
        ...domObservation(interval, expected),
        studies: [
          {
            selector: "study legend DOM item",
            text: `${expected!.identity} ${expected!.name}`,
            identity: `${expected!.identity}-EVIL`,
            name: `${expected!.name} Copy`,
            source: "pine",
          },
        ],
      }),
    });
    await expect(captureService(config, dataRoot, suffix).captureBatch(pineRequest())).rejects.toThrow(
      /exact saved_layout_pine indicator/i,
    );

    const duplicate = new FakeCaptureDriver({
      observation: (interval, expected) => {
        const observation = domObservation(interval, expected);
        return { ...observation, studies: [...observation.studies, ...observation.studies] };
      },
    });
    await expect(
      captureService(config, dataRoot, duplicate).captureBatch(pineRequest()),
    ).rejects.toThrow(/only proven overlay/i);
    await expectCaptureRootEmpty(dataRoot);
  });

  it.each([
    "sessionid=credential-value",
    "Bearer credential-value",
    "api_key:credential-value",
    "token=credential-value",
    "secret=credential-value",
    "ghp_1234567890abcdefghijklmnop",
    "sk-proj-1234567890abcdefghijklmnop",
    "https://user:password@example.invalid/indicator",
    "sessionid\ttest-session",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123",
  ])("rejects credential-like expected indicator metadata: %s", async (identity) => {
    const request = pineRequest();
    request.expectedIndicator = { identity, name: "Manager Ichimoku" };
    const driver = new FakeCaptureDriver();
    await expect(captureService(config, dataRoot, driver).captureBatch(request)).rejects.toThrow(
      /credential-like values are forbidden/i,
    );
    expect(driver.actions).toEqual([]);
    await expectCaptureRootEmpty(dataRoot);
  });

  it("requires explicit realtime evidence and complete empty comparison/drawing inventories", async () => {
    const cases: Array<[Partial<TradingViewCaptureDomObservation>, RegExp]> = [
      [{ realtimeActive: null }, /explicit active real-time/i],
      [{ sessionLabel: "Regular Trading Hours" }, /full day-and-night session/i],
      [{ sessionLabel: "通常取引時間" }, /full day-and-night session/i],
      [{ comparisonAuditComplete: false }, /comparison-series inventory is incomplete/i],
      [{ drawingAuditComplete: false }, /drawing inventory is incomplete/i],
      [
        {
          comparisons: [
            { selector: "comparison", text: "CME:ES1!", identity: "CME:ES1!", name: "ES" },
          ],
        },
        /comparison, drawing, collapsed-study, or unclassified/i,
      ],
      [{ collapsedStudyCount: 1 }, /collapsed-study/i],
      [{ unclassifiedSurfaceCount: 1 }, /unclassified/i],
    ];
    for (const [mutation, message] of cases) {
      const driver = new FakeCaptureDriver({
        observation: (interval) => ({ ...domObservation(interval, undefined), ...mutation }),
      });
      await expect(
        captureService(config, dataRoot, driver).captureBatch(candlesOnlyRequest()),
      ).rejects.toThrow(message);
      await expectCaptureRootEmpty(dataRoot);
    }
  });

  it("requires stable rendered canvas, OHLC, axes, and absence of loading UI", async () => {
    const cases: Array<[Partial<TradingViewCaptureDomObservation>, RegExp]> = [
      [{ renderAuditComplete: false }, /stable rendered candle canvas/i],
      [{ visibleCanvasCount: 0 }, /stable rendered candle canvas/i],
      [{ axisEvidenceCount: 1 }, /price\/time axes/i],
      [{ ohlcEvidenceVisible: false }, /OHLC/i],
      [{ loadingVisible: true }, /loading is still visible/i],
    ];
    for (const [mutation, message] of cases) {
      const driver = new FakeCaptureDriver({
        observation: (interval) => ({ ...domObservation(interval, undefined), ...mutation }),
      });
      await expect(
        captureService(config, dataRoot, driver).captureBatch(candlesOnlyRequest()),
      ).rejects.toThrow(message);
      await expectCaptureRootEmpty(dataRoot);
    }
  });

  it("requires the exact final HTTPS TradingView origin/layout/symbol/interval URL", async () => {
    for (const pageUrl of [
      "https://evil.example/chart/example_layout/?symbol=OSE%3ANK2251%21&interval=5",
      "https://jp.tradingview.com/chart/evil/?symbol=OSE%3ANK2251%21&interval=5",
      "https://jp.tradingview.com/chart/example_layout/?symbol=OSE%3ANK2251%21EVIL&interval=5",
      "https://jp.tradingview.com/chart/example_layout/?symbol=OSE%3ANK2251%21&interval=5&extra=1",
    ]) {
      const driver = new FakeCaptureDriver({
        observation: (interval) => ({
          ...domObservation(interval, undefined),
          ...(interval === "5" ? { pageUrl } : {}),
        }),
      });
      await expect(
        captureService(config, dataRoot, driver).captureBatch(candlesOnlyRequest()),
      ).rejects.toThrow(/final URL does not exactly match/i);
      await expectCaptureRootEmpty(dataRoot);
    }
  });

  it("binds sanitized evidence values into logical identity without archiving credentials", async () => {
    const first = await captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(
      candlesOnlyRequest(),
    );
    const varied = new FakeCaptureDriver({
      observation: (interval) => ({
        ...domObservation(interval, undefined),
        chartTypeLabel: "Candlesticks standard",
        sessionLabel: "OSE full day and night session Bearer SECRET",
      }),
    });
    const second = await captureService(config, dataRoot, varied).captureBatch(candlesOnlyRequest());
    expect(second.manifestIdentity).not.toBe(first.manifestIdentity);
    expect(JSON.stringify(second)).not.toContain("SECRET");
    expect(second.panels[0]!.observedBefore.evidence).toContainEqual(
      expect.objectContaining({ value: "[redacted credential-like value]" }),
    );
  });

  it("aborts on an upgrade dialog at batch start without taking any browser action", async () => {
    const driver = new FakeCaptureDriver({ forbiddenAtCheck: 1 });
    const service = captureService(config, dataRoot, driver);

    await expect(service.captureBatch(candlesOnlyRequest())).rejects.toThrow(/No dialog action/i);
    expect(driver.actions).toEqual(["readonly", "check:batch start"]);
    expect(driver.screenshotCount).toBe(0);
    await expectCaptureRootEmpty(dataRoot);
  });

  it("validates PNG dimensions/hash and removes a partially completed batch", async () => {
    const wrongDimensions = new FakeCaptureDriver({ png: makePng(1_799, 850) });
    await expect(
      captureService(config, dataRoot, wrongDimensions).captureBatch(candlesOnlyRequest()),
    ).rejects.toThrow(/dimensions 1799x850/i);
    await expectCaptureRootEmpty(dataRoot);

    const baseline = await captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(
      candlesOnlyRequest(),
    );
    const partial = new FakeCaptureDriver({ failScreenshotAt: 2 });
    await expect(
      captureService(config, dataRoot, partial).captureBatch(candlesOnlyRequest()),
    ).rejects.toThrow(/synthetic screenshot failure/i);
    expect(partial.screenshotCount).toBe(2);
    const captureRoot = path.join(dataRoot, "tradingview-captures");
    expect(JSON.parse(await readFile(path.join(captureRoot, "CURRENT"), "utf8"))).toMatchObject({
      batchId: baseline.batchId,
      manifestIdentity: baseline.manifestIdentity,
    });
    expect((await readdir(captureRoot)).sort()).toEqual(["CURRENT", baseline.batchId].sort());
  });

  it("fully decodes PNG IDAT scanlines instead of accepting an empty CRC-valid shell", async () => {
    const empty = new FakeCaptureDriver({ png: makeEmptyIdatPng(1_800, 850) });
    await expect(
      captureService(config, dataRoot, empty).captureBatch(candlesOnlyRequest()),
    ).rejects.toThrow(/IDAT stream cannot be decoded|decoded scanline size/i);
    await expectCaptureRootEmpty(dataRoot);
  });

  it("rejects a correctly encoded but visually blank PNG", async () => {
    const blank = new FakeCaptureDriver({ png: makeUniformPng(1_800, 850) });
    await expect(
      captureService(config, dataRoot, blank).captureBatch(candlesOnlyRequest()),
    ).rejects.toThrow(/visually blank or uniform/i);
    await expectCaptureRootEmpty(dataRoot);
  });

  it("restores and verifies the prior CURRENT pointer before removing a failed final batch", async () => {
    const baseline = await captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(
      candlesOnlyRequest(),
    );
    const service = new TradingViewBrowserService(
      config,
      dataRoot,
      testStore(),
      new FakeCaptureDriver(),
      undefined,
      {
        afterCurrentPublished: async () => {
          throw new Error("synthetic post-publication failure");
        },
      },
    );
    await expect(service.captureBatch(candlesOnlyRequest())).rejects.toThrow(
      /synthetic post-publication failure/i,
    );
    const current = await loadCurrentTradingViewCaptureManifest(dataRoot);
    expect(current.batchId).toBe(baseline.batchId);
    expect((await readdir(path.join(dataRoot, "tradingview-captures"))).sort()).toEqual(
      ["CURRENT", baseline.batchId].sort(),
    );
  });

  it("restores CURRENT when publication fails after its rename but before replacement returns", async () => {
    const baseline = await captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(
      candlesOnlyRequest(),
    );
    const service = new TradingViewBrowserService(
      config,
      dataRoot,
      testStore(),
      new FakeCaptureDriver(),
      undefined,
      {
        afterCurrentRenamed: async () => {
          throw new Error("synthetic post-CURRENT-rename failure");
        },
      },
    );
    await expect(service.captureBatch(candlesOnlyRequest())).rejects.toThrow(
      /synthetic post-CURRENT-rename failure/i,
    );
    const current = await loadCurrentTradingViewCaptureManifest(dataRoot);
    expect(current.batchId).toBe(baseline.batchId);
    expect((await readdir(path.join(dataRoot, "tradingview-captures"))).sort()).toEqual(
      ["CURRENT", baseline.batchId].sort(),
    );
  });

  it("retains the published final batch if CURRENT restoration cannot be verified", async () => {
    const baseline = await captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(
      candlesOnlyRequest(),
    );
    const service = new TradingViewBrowserService(
      config,
      dataRoot,
      testStore(),
      new FakeCaptureDriver(),
      undefined,
      {
        afterCurrentPublished: async () => {
          throw new Error("synthetic post-publication failure");
        },
        beforeRestoreCurrent: async () => {
          throw new Error("synthetic restoration failure");
        },
      },
    );
    await expect(service.captureBatch(candlesOnlyRequest())).rejects.toThrow(
      /CURRENT restoration could not be verified.*retained/i,
    );
    const retained = await loadCurrentTradingViewCaptureManifest(dataRoot);
    expect(retained.batchId).not.toBe(baseline.batchId);
    const entries = await readdir(path.join(dataRoot, "tradingview-captures"));
    expect(entries).toContain(baseline.batchId);
    expect(entries).toContain(retained.batchId);
  });

  it("anchors the temporary batch inode and rejects a symlink-swap TOCTOU attack", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "tv-capture-swap-outside-"));
    let swapped = false;
    const driver = new FakeCaptureDriver({
      beforeScreenshot: async () => {
        if (swapped) return;
        swapped = true;
        const root = path.join(dataRoot, "tradingview-captures");
        const temporary = (await readdir(root)).find((entry) => entry.endsWith(".tmp"));
        if (!temporary) throw new Error("temporary batch not found");
        await rename(path.join(root, temporary), path.join(root, `${temporary}.moved`));
        await symlink(outside, path.join(root, temporary), "dir");
      },
    });
    try {
      await expect(
        captureService(config, dataRoot, driver).captureBatch(candlesOnlyRequest()),
      ).rejects.toThrow(/directory binding changed/i);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("serializes publication across independent service instances and validates CURRENT hashes", async () => {
    const first = captureService(config, dataRoot, new FakeCaptureDriver());
    const second = captureService(config, dataRoot, new FakeCaptureDriver());
    const manifests = await Promise.all([
      first.captureBatch(candlesOnlyRequest()),
      second.captureBatch(candlesOnlyRequest()),
    ]);
    const current = await loadCurrentTradingViewCaptureManifest(dataRoot);
    expect(manifests.map((manifest) => manifest.batchId)).toContain(current.batchId);

    const manifestPath = path.join(
      dataRoot,
      "tradingview-captures",
      current.batchId,
      "manifest.json",
    );
    const originalManifest = await readFile(manifestPath);
    const tamperedManifest = JSON.parse(originalManifest.toString("utf8")) as {
      panels: Array<{ observedBefore: { evidence: Array<{ value: string }> } }>;
    };
    tamperedManifest.panels[0]!.observedBefore.evidence[0]!.value = "tampered evidence";
    await writeFile(manifestPath, `${JSON.stringify(tamperedManifest)}\n`);
    await expect(loadCurrentTradingViewCaptureManifest(dataRoot)).rejects.toThrow(
      /pointer\/manifest identity mismatch/i,
    );
    await writeFile(manifestPath, originalManifest);

    const timestampTampered = JSON.parse(originalManifest.toString("utf8")) as {
      batchEndedAt: string;
    };
    timestampTampered.batchEndedAt = new Date(
      Date.parse(timestampTampered.batchEndedAt) + 1_000,
    ).toISOString();
    await writeFile(manifestPath, `${JSON.stringify(timestampTampered)}\n`);
    await expect(loadCurrentTradingViewCaptureManifest(dataRoot)).rejects.toThrow(
      /pointer\/manifest identity mismatch/i,
    );
    await writeFile(manifestPath, originalManifest);

    const pngPath = path.join(dataRoot, current.panels[0]!.png.path);
    const png = await readFile(pngPath);
    png[png.length - 1] = png[png.length - 1]! ^ 1;
    await writeFile(pngPath, png);
    await expect(loadCurrentTradingViewCaptureManifest(dataRoot)).rejects.toThrow(/CRC|hash|PNG/i);
  });

  it("rejects invalid chronology even when a manifest and CURRENT pointer are resealed", async () => {
    const manifest = await captureService(
      config,
      dataRoot,
      new FakeCaptureDriver(),
    ).captureBatch(candlesOnlyRequest());
    const captureRoot = path.join(dataRoot, "tradingview-captures");
    const manifestPath = path.join(captureRoot, manifest.batchId, "manifest.json");
    const currentPath = path.join(captureRoot, "CURRENT");
    const invalid = structuredClone(manifest);
    invalid.panels[1]!.captureStartedAt = invalid.batchStartedAt;
    invalid.manifestIdentity = computeTradingViewCaptureManifestIdentity(invalid);
    await writeFile(manifestPath, `${JSON.stringify(invalid)}\n`);
    await writeFile(
      currentPath,
      `${JSON.stringify({
        schemaVersion: "tradingview-capture-current/v1",
        batchId: invalid.batchId,
        manifestIdentity: invalid.manifestIdentity,
      })}\n`,
    );

    await expect(loadCurrentTradingViewCaptureManifest(dataRoot)).rejects.toThrow(
      /overlap or run backward/i,
    );
  });

  it("CAS-rejects a CURRENT change between baseline read and durable publication", async () => {
    await captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(candlesOnlyRequest());
    const currentPath = path.join(dataRoot, "tradingview-captures", "CURRENT");
    const baseline = await readFile(currentPath);
    const racingDriver = new FakeCaptureDriver({
      beforeScreenshot: async (nextCount) => {
        if (nextCount === 6) await writeFile(currentPath, '{"attacker":true}\n');
      },
    });

    await expect(
      captureService(config, dataRoot, racingDriver).captureBatch(candlesOnlyRequest()),
    ).rejects.toThrow(/CURRENT changed during publication; CAS rejected/i);
    await writeFile(currentPath, baseline);
    await expect(loadCurrentTradingViewCaptureManifest(dataRoot)).resolves.toBeDefined();
  });

  it("refuses to follow a symlinked CURRENT pointer", async () => {
    await captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(candlesOnlyRequest());
    const currentPath = path.join(dataRoot, "tradingview-captures", "CURRENT");
    const outside = path.join(dataRoot, "outside-current.json");
    await writeFile(outside, '{"attacker":true}\n');
    await rm(currentPath);
    await symlink(outside, currentPath, "file");
    await expect(loadCurrentTradingViewCaptureManifest(dataRoot)).rejects.toThrow();
  });

  it("rejects a capture-root symlink that resolves outside the configured data root", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "tv-capture-outside-"));
    try {
      await symlink(outside, path.join(dataRoot, "tradingview-captures"), "dir");
      await expect(
        captureService(config, dataRoot, new FakeCaptureDriver()).captureBatch(candlesOnlyRequest()),
      ).rejects.toThrow(/resolved outside MARKET_CHART_DATA_ROOT/i);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

function cookie(name: string, value: string, domain: string) {
  return {
    name,
    value,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  };
}

const CAPTURE_INTERVALS = ["5", "60", "240", "D", "W", "M"] as const;
type CaptureInterval = (typeof CAPTURE_INTERVALS)[number];
const VALID_PNG = makePng(1_800, 850);

function frozenIdentityVector() {
  const batchId = "20260716-batch-fixture";
  return {
    schemaVersion: "tradingview-capture-batch/v1",
    source: "TradingView Supercharts official browser UI",
    batchId,
    batchStartedAt: "2026-07-16T00:59:59Z",
    batchEndedAt: "2026-07-16T01:00:06Z",
    captureSkewMs: 5_000,
    symbol: "OSE:NK2251!",
    layoutId: "example_layout",
    intervalOrder: [...CAPTURE_INTERVALS],
    requested: candlesOnlyRequest(),
    panels: CAPTURE_INTERVALS.map((interval, index) => {
      const second = String(index).padStart(2, "0");
      const observed = frozenIdentityObservedState(interval);
      return {
        index,
        requestedInterval: interval,
        captureStartedAt: `2026-07-16T01:00:${second}Z`,
        captureEndedAt: `2026-07-16T01:00:${second}.100000Z`,
        observedBefore: observed,
        observedAfter: structuredClone(observed),
        png: {
          path: `tradingview-captures/${batchId}/${String(index + 1).padStart(2, "0")}-${interval}.png`,
          sha256: "14f7e3c68961602f0b8b0badcd8b177c61c8fccd8b0c323d19bf6eedab264f62",
          bytes: 3_799,
          width: 1_800,
          height: 850,
        },
      };
    }),
    upgradeAttempted: false,
  };
}

function frozenIdentityObservedState(interval: CaptureInterval) {
  return {
    pageUrl: `https://jp.tradingview.com/chart/example_layout/?symbol=OSE%3ANK2251%21&interval=${interval}`,
    symbol: "OSE:NK2251!",
    exchange: "OSE",
    interval,
    intervalLabel: interval,
    chartAriaLabel: "Nikkei 225 Futures chart",
    chartType: "candles",
    chartTypeLabel: "Candles",
    authenticated: true,
    delayed: false,
    realtime: true,
    timezone: "Asia/Tokyo",
    session: "ose_full_day_and_night",
    backAdjustment: false,
    settlementAsClose: false,
    overlayMode: "candles_only",
    chartCount: 1,
    studyCount: 0,
    collapsedStudyCount: 0,
    comparisonCount: 0,
    drawingCount: 0,
    evidence: [
      ...Array.from({ length: 12 }, (_, index) => ({
        selector: `selector-${index}`,
        value: `value-${index}`,
      })),
      { selector: "duplicate-selector", value: "éclair" },
      { selector: "duplicate-selector", value: "Zebra" },
    ],
  };
}

function candlesOnlyRequest(): TradingViewCaptureBatchInput {
  return {
    symbol: "OSE:NK2251!",
    intervals: ["5", "60", "240", "D", "W", "M"],
    layoutId: "example_layout",
    width: 1_800,
    height: 850,
    chartOnly: false,
    requireAuthenticated: true,
    allowDelayed: false,
    expectedOverlayMode: "candles_only",
  };
}

function pineRequest(): TradingViewCaptureBatchInput {
  return {
    ...candlesOnlyRequest(),
    expectedOverlayMode: "saved_layout_pine",
    expectedIndicator: { identity: "PUB;author/script", name: "Manager Ichimoku" },
  };
}

function builtinRequest(): TradingViewCaptureBatchInput {
  return {
    ...candlesOnlyRequest(),
    expectedOverlayMode: "builtin_ichimoku_only",
    expectedIndicator: { identity: "STD;Ichimoku Cloud", name: "Ichimoku Cloud" },
  };
}

function captureService(
  config: AppConfig["tradingViewBrowser"],
  dataRoot: string,
  driver: TradingViewCaptureDriver,
): TradingViewBrowserService {
  return new TradingViewBrowserService(
    config,
    dataRoot,
    testStore(),
    driver,
  );
}

function testStore(): ChartStore {
  return new ChartStore({
    bars: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    symbol: "TEST:TEST",
    interval: "D",
    source: "test",
  });
}

class FakeCaptureDriver implements TradingViewCaptureDriver {
  readonly actions: string[] = [];
  screenshotCount = 0;
  #currentInterval: CaptureInterval = "5";
  #currentUrl = testCaptureUrl("5");
  #checkCount = 0;

  constructor(
    private readonly options: {
      observation?: (
        interval: CaptureInterval,
        expected: { identity: string; name: string } | undefined,
      ) => TradingViewCaptureDomObservation;
      forbiddenAtCheck?: number;
      png?: Buffer;
      failScreenshotAt?: number;
      beforeScreenshot?: (nextCount: number) => Promise<void>;
    } = {},
  ) {}

  async initializeReadOnly(): Promise<void> {
    this.actions.push("readonly");
  }

  async assertNoForbiddenDialog(stage: string): Promise<void> {
    this.#checkCount += 1;
    this.actions.push(`check:${stage}`);
    if (this.options.forbiddenAtCheck === this.#checkCount) {
      throw new Error(
        "TradingView capture aborted: upgrade dialog is visible. No dialog action was attempted.",
      );
    }
  }

  async setViewportSize(width: number, height: number): Promise<void> {
    this.actions.push(`viewport:${width}x${height}`);
  }

  async navigate(url: string): Promise<void> {
    this.actions.push(`navigate:${url}`);
    const interval = new URL(url).searchParams.get("interval");
    if (!CAPTURE_INTERVALS.includes(interval as CaptureInterval)) throw new Error("bad interval");
    this.#currentInterval = interval as CaptureInterval;
    this.#currentUrl = url;
  }

  async waitForStableChart(symbol: string, interval: CaptureInterval): Promise<void> {
    this.actions.push(`stable:${symbol}:${interval}`);
  }

  async auditLocalState(
    interval: CaptureInterval,
    _expectedOverlayMode: TradingViewCaptureBatchInput["expectedOverlayMode"],
    _expectedIndicator: { identity: string; name: string } | undefined,
  ): Promise<void> {
    this.actions.push(`audit:${interval}`);
  }

  async clearCrosshairAndTooltips(): Promise<void> {
    this.actions.push(`clear:${this.#currentInterval}`);
  }

  async pause(_milliseconds: number): Promise<void> {}

  async observe(
    _interval: CaptureInterval,
    expected: { identity: string; name: string } | undefined,
  ): Promise<TradingViewCaptureDomObservation> {
    return this.options.observation?.(this.#currentInterval, expected) ?? {
      ...domObservation(this.#currentInterval, expected),
      pageUrl: this.#currentUrl,
    };
  }

  async screenshotFullViewport(): Promise<Buffer> {
    await this.options.beforeScreenshot?.(this.screenshotCount + 1);
    this.screenshotCount += 1;
    this.actions.push(`screenshot:${this.#currentInterval}`);
    if (this.options.failScreenshotAt === this.screenshotCount) {
      throw new Error("synthetic screenshot failure");
    }
    return Buffer.from(this.options.png ?? VALID_PNG);
  }
}

function domObservation(
  interval: CaptureInterval,
  expected: { identity: string; name: string } | undefined,
): TradingViewCaptureDomObservation {
  const intervalLabels: Record<CaptureInterval, string> = {
    "5": "5 minutes",
    "60": "1 hour",
    "240": "4 hours",
    D: "1 day",
    W: "1 week",
    M: "1 month",
  };
  return {
    pageUrl: testCaptureUrl(interval),
    chartCount: 1,
    chartAuditComplete: true,
    chartAriaLabel: "OSE_DLY:NK2251! candlestick chart",
    chartSelector: 'visible [role="region"][aria-label]',
    symbolLinkHref: "https://jp.tradingview.com/symbols/OSE-NK2251!/",
    symbolLinkSelector: 'visible exact /symbols/OSE-NK2251!/ chart link',
    intervalLabel: intervalLabels[interval],
    intervalSelector: 'visible [data-name="header-intervals-button"]',
    chartTypeLabel: "Candlesticks",
    chartTypeSelector: "visible chart-type toolbar control",
    authenticatedControlVisible: true,
    authenticatedSelector: "visible authenticated-account control",
    delayedLabelVisible: false,
    realtimeLabel: "Real-time data",
    realtimeSelector: "chart-scoped realtime market-data control",
    realtimeActive: true,
    timezoneLabel: "Asia/Tokyo",
    timezoneSelector: "visible timezone control",
    sessionLabel: "OSE full day and night session",
    sessionSelector: "visible trading-session control",
    backAdjustment: {
      selector: "explicit back-adjustment control",
      label: "Back adjustment",
      active: false,
    },
    settlementAsClose: {
      selector: "explicit settlement-as-close control",
      label: "Settlement as close",
      active: false,
    },
    studyAuditSelector: "visible chart/pane legend study-item audit",
    studyAuditComplete: true,
    studies: expected
      ? [
          {
            selector: "study legend DOM item",
            text: `${expected.identity} ${expected.name}`,
            identity: expected.identity,
            name: expected.name,
            source: "pine",
          },
        ]
      : [],
    collapsedStudyCount: 0,
    comparisonAuditSelector: "chart-scoped complete legend source inventory",
    comparisonAuditComplete: true,
    comparisons: [],
    drawingAuditSelector: "chart-scoped pane drawing inventory",
    drawingAuditComplete: true,
    drawings: [],
    unclassifiedSurfaceCount: 0,
    settingsAuditSelector: "opened chart settings dialog and symbol tab",
    settingsAuditComplete: true,
    objectTreeAuditSelector: "opened and loaded chart Object Tree",
    objectTreeAuditComplete: true,
    renderAuditSelector: "chart-scoped visible canvas/OHLC/axis audit",
    renderAuditComplete: true,
    visibleCanvasCount: 4,
    axisEvidenceCount: 2,
    ohlcEvidenceVisible: true,
    loadingVisible: false,
  };
}

function testCaptureUrl(interval: CaptureInterval): string {
  const url = new URL("https://jp.tradingview.com/chart/example_layout/");
  url.searchParams.set("symbol", "OSE:NK2251!");
  url.searchParams.set("interval", interval);
  return url.toString();
}

async function expectCaptureRootEmpty(dataRoot: string): Promise<void> {
  const root = path.join(dataRoot, "tradingview-captures");
  const entries = await readdir(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  expect(entries).toEqual([]);
}

function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowBytes = width * 4;
  const scanlines = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      const band = (Math.floor(x / 80) + Math.floor(y / 60)) % 4;
      scanlines[pixel] = 20 + band * 35;
      scanlines[pixel + 1] = 28 + ((band + 1) % 4) * 32;
      scanlines[pixel + 2] = 38 + ((band + 2) % 4) * 28;
      scanlines[pixel + 3] = 255;
    }
  }
  const idat = deflateSync(scanlines);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND")]);
}

function makeUniformPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowBytes = width * 4;
  const scanlines = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      scanlines[pixel] = 24;
      scanlines[pixel + 1] = 24;
      scanlines[pixel + 2] = 24;
      scanlines[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ]);
}

function makeEmptyIdatPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT"), pngChunk("IEND")]);
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(testCrc32(Buffer.concat([name, data])), 8 + data.byteLength);
  return chunk;
}

function testCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
