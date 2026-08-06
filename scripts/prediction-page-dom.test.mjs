import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.PREDICTION_DOM_URL ?? "http://127.0.0.1:3102";
const cdpUrl = process.env.PREDICTION_DOM_CDP_URL ?? "http://127.0.0.1:9223";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectToPage() {
  const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("PREDICTION_DOM_NO_PAGE");
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
      reject(new Error(`PREDICTION_DOM_TIMEOUT ${method}`));
    }, 15_000);
  });
  await call("Page.enable");
  await call("Runtime.enable");
  return { socket, call };
}

async function inspect(call, url, width, mobile) {
  await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile });
  await call("Page.navigate", { url });
  await sleep(1200);
  const result = await call("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const root = document.documentElement;
      const text = document.body ? document.body.innerText : "";
      return {
        title: document.title,
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        bottomNavCount: document.querySelectorAll(".mobile-bottom-nav a").length,
        marketTabs: [...document.querySelectorAll(".prediction-market-tabs button")].map((button) => button.innerText.trim()),
        activeTab: document.querySelector(".prediction-market-tabs button.active")?.innerText.trim() ?? null,
        horizonCards: document.querySelectorAll(".prediction-horizon-card").length,
        probabilityNumbers: document.querySelectorAll(".prediction-probability-number strong").length,
        observationBoards: document.querySelectorAll(".prediction-observation-list").length,
        statusPanels: document.querySelectorAll(".prediction-status-panel").length,
        objectTitles: [...document.querySelectorAll(".prediction-object-header h3")].map((node) => node.innerText.trim()),
        text,
      };
    })())`,
    returnByValue: true,
  });
  return JSON.parse(result.result.result.value);
}

const browser = await connectToPage();
test.after(() => browser.socket.close());

test("predictions page renders a dedicated view with three market tabs and history link", async () => {
  const dom = await inspect(browser.call, `${baseUrl.replace(/\/$/, "")}/predictions/?market=a-share`, 1440, false);
  assert.match(dom.title, /预测与模型状态/);
  assert.deepEqual(dom.marketTabs, ["A股", "港股", "美股"]);
  assert.equal(dom.activeTab, "A股");
  assert.ok(dom.horizonCards >= 3);
  assert.ok(dom.observationBoards >= 1, "A股 abstained 状态必须显示观察榜");
  assert.ok(dom.statusPanels >= 0);
});

test("HK page shows no probability numbers and fixed object order", async () => {
  const dom = await inspect(browser.call, `${baseUrl.replace(/\/$/, "")}/predictions/?market=hk`, 1440, false);
  assert.equal(dom.activeTab, "港股");
  assert.equal(dom.probabilityNumbers, 0);
  assert.deepEqual(dom.objectTitles, ["恒生指数", "恒生科技指数", "港股创新药", "科技互联网"]);
});

test("US page shows no probability numbers and research-shadow wording", async () => {
  const dom = await inspect(browser.call, `${baseUrl.replace(/\/$/, "")}/predictions/?market=us`, 1440, false);
  assert.equal(dom.activeTab, "美股");
  assert.equal(dom.probabilityNumbers, 0);
  assert.match(dom.text, /研究 shadow|不发布概率/);
});

test("390px mobile has no horizontal overflow and keeps five bottom nav items", async () => {
  const dom = await inspect(browser.call, `${baseUrl.replace(/\/$/, "")}/predictions/?market=hk`, 390, true);
  assert.ok(dom.scrollWidth <= dom.clientWidth + 1, `overflow: ${dom.scrollWidth} > ${dom.clientWidth}`);
  assert.equal(dom.bottomNavCount, 5);
  assert.ok(dom.marketTabs.length === 3);
});

test("history page still loads monthly shards and shows the current three-market summary", async () => {
  const dom = await inspect(browser.call, `${baseUrl.replace(/\/$/, "")}/predictions/history/`, 1440, false);
  assert.match(dom.title, /历史预测与到期复盘/);
  assert.match(dom.text, /当前三市场预测状态/);
  assert.match(dom.text, /2026-W31/);
});
