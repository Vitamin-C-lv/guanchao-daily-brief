import fs from "node:fs";
import path from "node:path";

const output = process.argv[2] ?? "C:/Codex-Recovery/GuanchaoWriter/audits/guanchao-writer-publisher-investment-strategy-convergence-20260812-v3/browser";
fs.mkdirSync(output, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return await new Promise((resolve, reject) => {
    const listener = (event) => {
      const value = JSON.parse(event.data);
      if (value.id !== id) return;
      ws.removeEventListener("message", listener);
      if (value.error) reject(new Error(JSON.stringify(value.error))); else resolve(value.result);
    };
    ws.addEventListener("message", listener);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function page() {
  const target = await (await fetch("http://127.0.0.1:9222/json/new?http://127.0.0.1:3126/" , { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  await call(ws, "Page.enable");
  return ws;
}
const ws = await page();
async function visit(name, url, expression) {
  await call(ws, "Page.navigate", { url });
  await sleep(1000);
  const result = await call(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const screenshot = await call(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(screenshot.data, "base64"));
  return result.result?.value ?? null;
}
const results = {};
results.home = await visit("HOME_MIGRATION", "http://127.0.0.1:3126/", `(() => ({ body: document.body.innerText, cards: [...document.querySelectorAll('article,section')].map((x) => x.innerText).filter(Boolean).slice(0, 20) }))()`);
results.weekly = await visit("W32_NO_RETROACTIVE_STRATEGY", "http://127.0.0.1:3126/weekly/weekly-2026-W32", `(() => ({ hasStrategy: document.body.innerText.includes('配置建议'), body: document.body.innerText.slice(0, 4000) }))()`);
results.briefs = await visit("BRIEFS_ARCHIVE", "http://127.0.0.1:3126/briefs", `(() => ({ body: document.body.innerText.slice(0, 4000), links: [...document.querySelectorAll('a')].map((x) => x.getAttribute('href')).filter(Boolean).slice(0, 30) }))()`);
fs.writeFileSync(path.join(output, "BROWSER_QA_RESULT.json"), `${JSON.stringify(results, null, 2)}\n`);
ws.close();
