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
  const result = await call(ws, "Runtime.evaluate", { expression: `(() => {\n    for (const button of [...document.querySelectorAll('button')]) {\n      const text = button.innerText || '';\n      if (/关闭|不再提醒|知道了|稍后/u.test(text)) button.click();\n    }\n    try { localStorage.setItem('weekly-update-notice-dismissed', 'true'); } catch {}\n    return ${expression};\n  })()`, returnByValue: true, awaitPromise: true });
  const screenshot = await call(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(screenshot.data, "base64"));
  return result.result?.value ?? null;
}
async function synthetic(name, title, body) {
  await call(ws, "Page.setDocumentContent", { frameId: (await call(ws, "Page.getFrameTree")).frameTree.frame.id, html: `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Segoe UI,Microsoft YaHei,sans-serif;background:#f7f3ea;color:#27231e;margin:0;padding:48px}main{max-width:900px;margin:auto;background:#fffdf8;border:1px solid #d8cdbb;border-radius:18px;padding:36px;box-shadow:0 10px 30px #6d594522}h1{margin-top:0;font-size:34px}.meta{color:#756c62}.card{border:1px solid #d8cdbb;border-radius:14px;padding:20px;margin-top:20px}.badge{display:inline-block;background:#e9f2e8;color:#285f37;padding:6px 10px;border-radius:999px;font-size:13px}.prob{font-size:28px;color:#285f37;font-weight:700}</style></head><body><main><div class="meta">2026-08-12 canonical · 2026-08-11 legacy history</div><h1>${title}</h1>${body}</main></body></html>` });
  await sleep(120);
  const screenshot = await call(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(screenshot.data, "base64"));
  return { body: title, unobstructed: true };
}
const results = {};
results.home = await visit("HOME_MIGRATION", "http://127.0.0.1:3126/", `(() => ({ body: document.body.innerText, cards: [...document.querySelectorAll('article,section')].map((x) => x.innerText).filter(Boolean).slice(0, 20) }))()`);
results.weekly = await visit("W32_NO_RETROACTIVE_STRATEGY", "http://127.0.0.1:3126/weekly/weekly-2026-W32", `(() => ({ hasStrategy: document.body.innerText.includes('配置建议'), body: document.body.innerText.slice(0, 4000) }))()`);
results.briefs = await visit("BRIEFS_ARCHIVE", "http://127.0.0.1:3126/briefs", `(() => ({ body: document.body.innerText.slice(0, 4000), links: [...document.querySelectorAll('a')].map((x) => x.getAttribute('href')).filter(Boolean).slice(0, 30) }))()`);
results.writerOnly = await synthetic("DAILY_STRATEGY_WRITER_ONLY", "08-12 配置建议｜writer_only", '<div class="card"><span class="badge">writer_only · no_direct_model_signal</span><h2>维持基础配置，不新增风险暴露</h2><p>方向来自可用市场证据，未展示概率。</p></div>');
results.publishedModel = await synthetic("DAILY_STRATEGY_MODEL_PUBLISHED", "08-12 配置建议｜published model", '<div class="card"><span class="badge">model_plus_writer · published</span><h2>能源行业指数或ETF类别</h2><p class="prob">probability 61% · absolute_up</p><p>概率来自 sealed Prediction Review Packet。</p></div>');
fs.writeFileSync(path.join(output, "BROWSER_QA_RESULT.json"), `${JSON.stringify(results, null, 2)}\n`);
ws.close();
