import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userArgs = process.argv.slice(2).filter((argument) => argument !== "--");

if (userArgs.length === 0) {
  console.error("用法: node scripts/run-sector-rotation.mjs <fetch|signals|features|probability-train|infer|history|refresh|market-breadth|events-append|events-prune> [...参数]");
  process.exit(2);
}

const probabilityTrain = userArgs[0] === "probability-train";
const predictionHistory = userArgs[0] === "history";
const rotationSignals = userArgs[0] === "signals";
const marketBreadth = userArgs[0] === "market-breadth";
const normalizer = path.join(root, "scripts", "normalize-prediction-contract.mjs");
const script = path.join(root, "scripts", probabilityTrain ? "sector_probability.py" : predictionHistory ? "prediction_ledger_automation.py" : rotationSignals ? "collect-rotation-signals.py" : marketBreadth ? "market_breadth.py" : "sector_rotation.py");
const scriptArgs = probabilityTrain ? ["train", ...userArgs.slice(1)] : predictionHistory ? ["--mode", "closing", ...userArgs.slice(1)] : rotationSignals || marketBreadth ? userArgs.slice(1) : userArgs;

const candidates = [];
if (!probabilityTrain && process.env.CODEX_PYTHON) {
  candidates.push({ command: process.env.CODEX_PYTHON, prefix: [], label: "CODEX_PYTHON" });
}
if (!probabilityTrain) {
  candidates.push(
    { command: "python", prefix: [], label: "python" },
    { command: "py", prefix: ["-3"], label: "py -3" },
  );
}
candidates.push({
  command: "uv",
  prefix: ["run", "--no-project", "--python", "3.12", "--with", "requests", ...(probabilityTrain ? ["--with", "numpy"] : []), ...((userArgs[0] === "refresh" || marketBreadth) ? ["--with", "xlrd"] : []), "python"],
  label: "uv managed Python",
});

let selected = null;
for (const candidate of candidates) {
  const probe = spawnSync(
    candidate.command,
    [...candidate.prefix, "-c", `${userArgs[0] === "refresh" || marketBreadth ? "import requests,xlrd" : "import requests"},sys; print(sys.executable)`],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  if (!probe.error && probe.status === 0) {
    selected = candidate;
    break;
  }
}

if (!selected) {
  console.error(
    "找不到可用的 Python 3 + requests。请设置 CODEX_PYTHON，或安装 python/py/uv；不会使用硬编码用户缓存路径。",
  );
  process.exit(1);
}

const result = spawnSync(selected.command, [...selected.prefix, script, ...scriptArgs], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`行业轮动 ${selected.label} 启动失败: ${result.error.message}`);
  process.exit(1);
}
if (result.status === 0 && ["history", "refresh", "infer"].includes(userArgs[0])) {
  const normalized = spawnSync(process.execPath, [normalizer], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (normalized.error || normalized.status !== 0) {
    console.error(`预测状态契约归一化失败：${normalized.error?.message ?? `exit ${normalized.status}`}`);
    process.exit(normalized.status ?? 1);
  }
}
process.exit(result.status ?? 1);
