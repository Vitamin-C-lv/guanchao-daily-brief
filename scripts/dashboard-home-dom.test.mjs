import assert from "node:assert/strict";
import test from "node:test";

const globalBaseUrl = process.env.DASHBOARD_DOM_GLOBAL_URL ?? "http://127.0.0.1:3110";
const fallbackBaseUrl = process.env.DASHBOARD_DOM_FALLBACK_URL ?? "http://127.0.0.1:3111";
const cdpUrl = process.env.DASHBOARD_DOM_CDP_URL ?? "http://127.0.0.1:9222";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectToPage() {
  const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("DASHBOARD_DOM_NO_PAGE");
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
      reject(new Error(`DASHBOARD_DOM_TIMEOUT ${method}`));
    }, 15_000);
  });
  await call("Page.enable");
  await call("Runtime.enable");
  return { socket, call };
}

async function inspectHome(call, baseUrl) {
  await call("Page.navigate", { url: `${baseUrl.replace(/\/$/, "")}/` });
  await sleep(800);
  const result = await call("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const reminder = [...document.querySelectorAll("button")].find((button) => button.innerText.trim() === "不再提醒此类更新");
      reminder?.click();
      document.querySelector('button[aria-label="关闭本期提醒"]')?.click();
      const body = document.body.innerText;
      return {
        oldTitle: body.includes("缩量回调与新高并存"),
        oldEdition: body.includes("2026-08-04日报"),
        globalJudgment: body.includes("今日全球判断"),
        marketOverview: body.includes("市场数据概览"),
        legacyHeroCount: document.querySelectorAll(".hero-card").length,
      };
    })())`,
    returnByValue: true,
  });
  return JSON.parse(result.result.result.value);
}

const browser = await connectToPage();
test.after(() => browser.socket.close());

test("valid same-edition global DTO removes the legacy home narrative DOM", async () => {
  const dom = await inspectHome(browser.call, globalBaseUrl);
  assert.equal(dom.oldTitle, false);
  assert.equal(dom.oldEdition, false);
  assert.equal(dom.globalJudgment, true);
  assert.equal(dom.marketOverview, true);
  assert.equal(dom.legacyHeroCount, 0);
});

test("missing global DTO preserves the legacy home fallback DOM", async () => {
  const dom = await inspectHome(browser.call, fallbackBaseUrl);
  assert.equal(dom.oldTitle, true);
  assert.equal(dom.oldEdition, true);
  assert.equal(dom.globalJudgment, false);
  assert.equal(dom.marketOverview, false);
  assert.equal(dom.legacyHeroCount, 1);
});
