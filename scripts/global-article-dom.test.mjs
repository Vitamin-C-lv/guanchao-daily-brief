import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const baseUrl = process.env.GLOBAL_ARTICLE_DOM_URL ?? "http://127.0.0.1:3108";
const cdpUrl = process.env.GLOBAL_ARTICLE_DOM_CDP_URL ?? "http://127.0.0.1:9222";
const articlePath = "/articles/global-market-brief-2026-08-08/";
const viewports = [
  { name: "1920 desktop", width: 1920, height: 1080, expectedFactColumns: 2, expectedLogicColumns: 2 },
  { name: "1440 desktop", width: 1440, height: 1000, expectedFactColumns: 2, expectedLogicColumns: 2 },
  { name: "1180 tablet edge", width: 1180, height: 820, expectedFactColumns: 2, expectedLogicColumns: 2 },
  { name: "1024 tablet", width: 1024, height: 1366, expectedFactColumns: 2, expectedLogicColumns: 2 },
  { name: "820 narrow tablet", width: 820, height: 1180, expectedFactColumns: 2, expectedLogicColumns: 1 },
  { name: "390 mobile", width: 390, height: 844, expectedFactColumns: 1, expectedLogicColumns: 1 },
];
const expectedOrder = ["logic-chain", "introduction", "transmission", "analysis", "facts", "outlook", "invalidation-conditions", "watch-items", "sources"];
const screenshotDirectory = process.env.GLOBAL_ARTICLE_SCREENSHOT_DIR;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectToPage() {
  const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("GLOBAL_ARTICLE_DOM_NO_PAGE");
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
      reject(new Error(`GLOBAL_ARTICLE_DOM_TIMEOUT ${method}`));
    }, 15_000);
  });
  await call("Page.enable");
  await call("Runtime.enable");
  return { socket, call };
}

async function inspect(call, viewport) {
  await call("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width <= 767,
  });
  await call("Page.navigate", { url: `${baseUrl.replace(/\/$/, "")}${articlePath}` });
  await sleep(700);
  await call("Runtime.evaluate", {
    expression: `(() => {
      const reminder = [...document.querySelectorAll('button')].find((button) => button.innerText.trim() === '不再提醒此类更新');
      reminder?.click();
      document.querySelector('button[aria-label="关闭本期提醒"]')?.click();
    })()`,
  });
  await sleep(250);
  const result = await call("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const root = document.documentElement;
      const article = document.querySelector('.global-full-article');
      const facts = document.querySelector('.global-full-facts-grid');
      const logic = document.querySelector('.global-full-logic-list');
      const prose = document.querySelector('.global-full-analysis-sections');
      const columns = (node) => node ? getComputedStyle(node).gridTemplateColumns.trim().split(/\\s+/).length : 0;
      return {
        title: document.title,
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        order: [...document.querySelectorAll('[data-global-section]')].map((node) => node.getAttribute('data-global-section')),
        introHeading: document.querySelector('[data-global-section="introduction"] h2')?.innerText ?? '',
        factsCount: document.querySelectorAll('.global-full-fact').length,
        factColumns: columns(facts),
        logicColumns: columns(logic),
        articleWidth: article?.getBoundingClientRect().width ?? 0,
        proseWidth: prose?.getBoundingClientRect().width ?? 0,
      };
    })())`,
    returnByValue: true,
  });
  if (screenshotDirectory) {
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    fs.writeFileSync(path.join(screenshotDirectory, `global-article-${viewport.width}x${viewport.height}.png`), Buffer.from(screenshot.result.data, "base64"));
  }
  return JSON.parse(result.result.result.value);
}

const browser = await connectToPage();
test.after(() => browser.socket.close());

test("global main article keeps the reader-first section order at every requested viewport", async () => {
  for (const viewport of viewports) {
    const dom = await inspect(browser.call, viewport);
    assert.equal(dom.title.includes("非农落地后风险偏好回暖"), true, `${viewport.name} title`);
    assert.deepEqual(dom.order, expectedOrder, `${viewport.name} section order`);
    assert.equal(dom.introHeading, "引言", `${viewport.name} introduction label`);
    assert.ok(dom.factsCount > 0, `${viewport.name} facts rendered`);
    assert.equal(dom.factColumns, viewport.expectedFactColumns, `${viewport.name} facts columns`);
    assert.equal(dom.logicColumns, viewport.expectedLogicColumns, `${viewport.name} logic columns`);
    assert.ok(dom.scrollWidth <= dom.clientWidth + 1, `${viewport.name} overflow: ${dom.scrollWidth} > ${dom.clientWidth}`);
    if (viewport.width >= 1440) assert.ok(dom.articleWidth >= 1080, `${viewport.name} article too narrow: ${dom.articleWidth}`);
    if (viewport.width >= 1024 && viewport.width < 1440) assert.ok(dom.articleWidth >= 900, `${viewport.name} article too narrow: ${dom.articleWidth}`);
    if (viewport.width >= 768) assert.ok(dom.proseWidth <= 820, `${viewport.name} prose too wide: ${dom.proseWidth}`);
  }
});
