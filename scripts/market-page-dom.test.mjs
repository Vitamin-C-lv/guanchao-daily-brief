import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.MARKET_DOM_URL ?? "http://127.0.0.1:3104";
const cdpUrl = process.env.MARKET_DOM_CDP_URL ?? "http://127.0.0.1:9224";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectToPage() {
  const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("MARKET_DOM_NO_PAGE");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`MARKET_DOM_TIMEOUT ${method}`));
    }, 15_000);
  });
  await call("Page.enable");
  await call("Runtime.enable");
  return { socket, call };
}

async function inspect(call, market, width, mobile) {
  await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile });
  await call("Page.navigate", { url: `${baseUrl.replace(/\/$/, "")}/markets/` });
  await sleep(1_000);
  if (market !== "a-share") {
    await call("Runtime.evaluate", { expression: `([...document.querySelectorAll('.market-switch button')].find((button) => button.innerText.trim() === ${JSON.stringify(market === "hk" ? "港股" : "美股")}))?.click()` });
    await sleep(350);
  }
  const result = await call("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const root = document.documentElement;
      const tabs = [...document.querySelectorAll('.market-switch button')];
      const cards = [...document.querySelectorAll('[data-market-instrument]')];
      const core = document.querySelector('.market-core-section');
      const observation = document.querySelector('.market-observation-section');
      const sidebar = document.querySelector('.sidebar');
      const statusCells = [...document.querySelectorAll('.market-status-strip > div')];
      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        tabs: tabs.map((button) => button.innerText.trim()),
        activeTab: tabs.find((button) => button.getAttribute('aria-selected') === 'true')?.innerText.trim() ?? null,
        cards: cards.map((card) => ({ id: card.getAttribute('data-market-instrument'), text: card.innerText })),
        breadth: document.querySelector('.market-breadth-card')?.innerText ?? '',
        sidebarCount: document.querySelectorAll('.sidebar nav a').length,
        sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
        activeSidebar: document.querySelector('.sidebar nav a[aria-current="page"]')?.getAttribute('href') ?? null,
        observationBelowCore: Boolean(core && observation && observation.getBoundingClientRect().top > core.getBoundingClientRect().bottom),
        directionClasses: cards.map((card) => card.querySelector('.market-core-change')?.className ?? ''),
        detailLinks: cards.map((card) => card.getAttribute('href')),
        topbarText: document.querySelector('.topbar')?.innerText ?? '',
        factStatus: document.querySelector('.market-fact-status')?.innerText ?? '',
        sessionStatus: statusCells[0]?.innerText ?? '',
        commonDataThrough: statusCells[1]?.innerText ?? '',
        freshness: statusCells[2]?.innerText ?? '',
      };
    })())`,
    returnByValue: true,
  });
  return JSON.parse(result.result.result.value);
}

const browser = await connectToPage();
test.after(() => browser.socket.close());

test("desktop market overview keeps the shared sidebar and selected A/HK/US core order", async () => {
  const expected = {
    "a-share": ["sse-composite", "szse-component", "chinext"],
    hk: ["hang-seng", "hang-seng-china-enterprises", "hang-seng-tech"],
    us: ["dow-jones", "nasdaq-composite", "sp500"],
  };
  for (const market of ["a-share", "hk", "us"]) {
    const dom = await inspect(browser.call, market, 1440, false);
    assert.deepEqual(dom.tabs, ["A股", "港股", "美股"]);
    assert.equal(dom.activeTab, market === "a-share" ? "A股" : market === "hk" ? "港股" : "美股");
    assert.deepEqual(dom.cards.map((card) => card.id), expected[market]);
    assert.equal(dom.sidebarCount, 6);
    assert.equal(dom.sidebarWidth, 84);
    assert.equal(dom.activeSidebar?.replace(/\/$/, ""), "/markets");
    assert.equal(dom.breadth.includes("市场广度数据暂不可用"), true);
    assert.equal(dom.observationBelowCore, true);
    assert.equal(dom.cards.length, 3);
    assert.equal(dom.topbarText.includes("8月3日"), false);
    assert.equal(dom.factStatus, "核心指数数据已校验");
    assert.equal(dom.sessionStatus.includes("8月3日"), false);
    assert.equal(dom.sessionStatus.includes("A股收盘"), false);
    assert.equal(dom.sessionStatus.includes("港股收盘"), false);
    assert.equal(dom.sessionStatus.includes("美股收高"), false);
    assert.equal(dom.commonDataThrough.includes(market === "a-share" ? "2026.08.07" : market === "hk" ? "2026.08.06" : "2026.08.05"), true);
    if (market === "hk") assert.equal(dom.freshness.includes("部分指数晚于/早于共同交易日"), true);
    const hstech = dom.cards.find((card) => card.id === "hang-seng-tech");
    if (hstech) {
      assert.equal(hstech.text.includes("点差 —"), false);
      assert.equal(hstech.text.includes("+1.00%"), false);
    }
  }
});

test("390px market overview scrolls index cards without page overflow", async () => {
  for (const market of ["a-share", "hk", "us"]) {
    const dom = await inspect(browser.call, market, 390, true);
    assert.ok(dom.scrollWidth <= dom.clientWidth + 1, `${market} overflow: ${dom.scrollWidth} > ${dom.clientWidth}`);
    assert.equal(dom.cards.length, 3);
    assert.equal(dom.detailLinks.length, 3);
  }
});

test("predictions routes retain one shared desktop sidebar", async () => {
  for (const url of ["/predictions/", "/predictions/history/"]) {
    await browser.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.call("Page.navigate", { url: `${baseUrl.replace(/\/$/, "")}${url}` });
    await sleep(900);
    const result = await browser.call("Runtime.evaluate", { expression: "JSON.stringify({ count: document.querySelectorAll('.sidebar nav a').length, active: document.querySelector('.sidebar nav a[aria-current=\\\"page\\\"]')?.getAttribute('href') ?? null })", returnByValue: true });
    const dom = JSON.parse(result.result.result.value);
    assert.equal(dom.count, 6);
    assert.equal(dom.active?.replace(/\/$/, ""), "/predictions");
  }
});
