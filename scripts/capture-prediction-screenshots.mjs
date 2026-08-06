#!/usr/bin/env node
/**
 * Captures the 11 PAGE_SPEC screenshots from the final commit's static export
 * and records objective DOM assertions plus overflow checks.
 *
 * Usage:
 *   node scripts/capture-prediction-screenshots.mjs \
 *     --base-url http://127.0.0.1:3102 \
 *     --out-dir <screenshots-dir> \
 *     --fixture-dir <fixture-json-dir> \
 *     --cdp-port 9223
 *
 * Fixture screenshots (published-probability / abstained) are produced by
 * intercepting /data/predictions/current.json in the browser; no production
 * test route is created. All screenshots come from the same static export.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) throw new Error(`unknown argument: ${values[index]}`);
    const key = values[index].slice(2);
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return result;
}

async function connect(port) {
  let targets;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  const page = targets?.find((target) => target.type === "page");
  if (!page) throw new Error("no CDP page target");
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
      reject(new Error(`CDP timeout ${method}`));
    }, 30_000);
  });
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  return { socket, call };
}

async function evaluate(call, expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(result.result.exceptionDetails).slice(0, 300)}`);
  }
  return result.result?.result?.value;
}

async function capturePage(call, { url, width, height, mobile, name, outDir }) {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  await call("Page.navigate", { url });
  await sleep(1200);
  await sleep(400);
  const dom = await evaluate(call, `JSON.stringify((() => {
    const root = document.documentElement;
    const body = document.body;
    const text = body ? body.innerText : "";
    return {
      title: document.title,
      bodyText: text,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      hasHorizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      bottomNavCount: document.querySelectorAll(".mobile-bottom-nav a").length,
      probabilityNumberCount: document.querySelectorAll(".prediction-probability-number strong").length,
      observationBoardCount: document.querySelectorAll(".prediction-observation-list").length,
      statusPanelCount: document.querySelectorAll(".prediction-status-panel").length,
      marketTabCount: document.querySelectorAll(".prediction-market-tabs button").length,
      hasHistoryLink: !!document.querySelector("a.prediction-history-link"),
      hasNoProbabilityWording: text.includes("不发布概率") || text.includes("不是概率"),
    };
  })())`);
  const parsed = JSON.parse(dom);
  const shotMessage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
  const shotData = shotMessage.result?.data;
  if (!shotData) throw new Error("captureScreenshot returned no data");
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(shotData, "base64"));
  return { name, url, viewport: { width, height, mobile }, dom: parsed, screenshot: path.basename(file) };
}

async function fixtureServer(exportDir, fixtureFile, port) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stage3-fixture-server-"));
  fs.cpSync(exportDir, temp, { recursive: true });
  const target = path.join(temp, "data", "predictions", "current.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fixtureFile, target);
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".css": "text/css",
    ".js": "text/javascript",
    ".webmanifest": "application/manifest+json",
    ".ico": "image/x-icon",
    ".txt": "text/plain",
  };
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    let filePath = path.join(temp, urlPath === "/" ? "index.html" : urlPath);
    if (!filePath.startsWith(temp)) { response.writeHead(403); response.end(); return; }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
    fs.readFile(filePath, (error, data) => {
      if (error) { response.writeHead(404); response.end("not found"); return; }
      response.writeHead(200, { "Content-Type": mime[path.extname(filePath)] ?? "application/octet-stream" });
      response.end(data);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, temp, baseUrl: `http://127.0.0.1:${port}` };
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args["base-url"] ?? "http://127.0.0.1:3102").replace(/\/$/, "");
const outDir = path.resolve(args["out-dir"] ?? "screenshots");
const fixtureDir = args["fixture-dir"] ? path.resolve(args["fixture-dir"]) : null;
const exportDir = path.resolve(args["export-dir"] ?? path.join(process.cwd(), "out"));
const cdpPort = Number(args["cdp-port"] ?? 9223);
fs.mkdirSync(outDir, { recursive: true });

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "stage3-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=" + cdpPort,
  "--user-data-dir=" + userData,
  "about:blank",
], { stdio: "ignore", windowsHide: true });

let socket;
let sequence = 0;
try {
  const client = await connect(cdpPort);
  socket = client.socket;
  const call = client.call;
  const records = [];

  const targets = [
    ["predictions-a-1920.png", `${baseUrl}/predictions/?market=a-share`, 1920, 900, false, null],
    ["predictions-a-1440.png", `${baseUrl}/predictions/?market=a-share`, 1440, 900, false, null],
    ["predictions-a-390.png", `${baseUrl}/predictions/?market=a-share`, 390, 844, true, null],
    ["predictions-hk-1440.png", `${baseUrl}/predictions/?market=hk`, 1440, 900, false, null],
    ["predictions-hk-390.png", `${baseUrl}/predictions/?market=hk`, 390, 844, true, null],
    ["predictions-us-1440.png", `${baseUrl}/predictions/?market=us`, 1440, 900, false, null],
    ["predictions-us-390.png", `${baseUrl}/predictions/?market=us`, 390, 844, true, null],
    ["prediction-history-1440.png", `${baseUrl}/predictions/history/`, 1440, 900, false, null],
    ["prediction-history-390.png", `${baseUrl}/predictions/history/`, 390, 844, true, null],
  ];
  for (const [name, url, width, height, mobile] of targets) {
    records.push(await capturePage(call, { url, width, height, mobile, name, outDir }));
  }

  if (fixtureDir) {
    const publishedFixture = path.join(fixtureDir, "published-current.json");
    const abstainedFixture = path.join(fixtureDir, "abstained-current.json");
    if (fs.existsSync(publishedFixture)) {
      const server = await fixtureServer(exportDir, publishedFixture, 3103);
      try {
        records.push(await capturePage(call, {
          url: `${server.baseUrl}/predictions/?market=hk`,
          width: 1440,
          height: 900,
          mobile: false,
          name: "published-probability-fixture-1440.png",
          outDir,
        }));
      } finally {
        server.server.close();
        try { fs.rmSync(server.temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* ignore */ }
      }
    }
    if (fs.existsSync(abstainedFixture)) {
      const server = await fixtureServer(exportDir, abstainedFixture, 3104);
      try {
        records.push(await capturePage(call, {
          url: `${server.baseUrl}/predictions/?market=hk`,
          width: 390,
          height: 844,
          mobile: true,
          name: "abstained-fixture-390.png",
          outDir,
        }));
      } finally {
        server.server.close();
        try { fs.rmSync(server.temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* ignore */ }
      }
    }
  }

  const report = {
    schemaVersion: "stage3-visual-dom-assertions-v1",
    generatedAt: new Date().toISOString(),
    baseUrl,
    chrome: process.env.CHROME_PATH ?? CHROME,
    captures: records.map((record) => ({
      name: record.name,
      url: record.url,
      viewport: record.viewport,
      screenshot: record.screenshot,
      assertions: {
        title: record.dom.title,
        hasHorizontalOverflow: record.dom.hasHorizontalOverflow,
        bottomNavCount: record.dom.bottomNavCount,
        probabilityNumberCount: record.dom.probabilityNumberCount,
        observationBoardCount: record.dom.observationBoardCount,
        statusPanelCount: record.dom.statusPanelCount,
        marketTabCount: record.dom.marketTabCount,
        hasHistoryLink: record.dom.hasHistoryLink,
        hasNoProbabilityWording: record.dom.hasNoProbabilityWording,
      },
    })),
  };
  fs.writeFileSync(path.join(outDir, "..", "VISUAL_DOM_ASSERTIONS.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  await sleep(600);
  try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* ignore */ }
}
