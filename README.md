# 观潮 · 每日市场情报

一个面向个人使用的响应式每日早报，覆盖美联储政策、A 股、港股、美股和近期财经热点。页面按参考图采用浅紫灰背景、白色大卡片、黑色粗标题与柔和渐变；桌面端使用侧栏和多栏仪表盘，手机竖屏使用单列卡片、横滑市场卡和底部导航。

## 数据方式

本站不追求实时行情。页面内容来自 `content/daily-brief.json`，每日 AI 自动化完成全网检索、来源核验、摘要和引用整理后更新这一个文件，再重新构建网站。

- 每条简报和热点都带原文引用，可点击跳转。
- 首页条目可进入精读页；每篇正文控制在 1000 字内，并按段标注引用，必要时附轻量数据图表。
- 三地市场分别使用各自最新完整交易日。
- 政策信息优先引用官方原文。
- 同花顺、东方财富用于资讯发现或交叉验证，重大结论仍回查官方公告或第二来源。
- 自动化编辑规则见 `content/AUTOMATION_PROMPT.md`。

## 本机轻量备份

每日内容校验通过后运行：

```powershell
pnpm archive:brief
```

压缩快照保存在 `data/archive/YYYY/MM/`，索引为 `data/archive/index.json`。归档只保存结构化简报、精读正文和来源 URL，不保存来源网页全文、图片、视频或网页副本；按正文 SHA-256 去重，最多保留 400 份，总容量上限 50 MB，超限后自动从最旧记录开始清理。归档数据只保存在本机，默认不提交到 Git。

## 本地运行

需要 Node.js 20.9 或更高版本与 pnpm。

```powershell
pnpm install
pnpm dev
```

浏览器打开 `http://localhost:3000`。

## 内容与构建校验

```powershell
pnpm validate:brief
pnpm typecheck
pnpm build
```

`next build` 会在 `out/` 生成可静态部署的网站。当前生产站点发布到 `https://guanchao-daily-brief.vercel.app/`，Vercel 已连接 GitHub 私人仓库；每次 `main` 分支推送都会自动生成新的生产部署。

## 自动化链路

```text
每日定时触发
  → AI 浏览和筛选可信来源
  → 交叉核验并生成中文摘要
  → 更新 content/daily-brief.json
  → 内容校验 + 本机压缩归档
  → 类型检查 + 静态构建
  → Git 提交与推送
  → Vercel Git 自动生产发布
  → 固定网址 HTTP 与页面内容验证
```

在 Codex 自动化中使用 `content/AUTOMATION_PROMPT.md` 作为任务说明。首次上线前需配置 GitHub 远端并在 Vercel 连接该仓库；本地未配置远端时，自动化只会更新本机文件。

## 重要说明

本项目仅作信息整理，不构成投资建议。摘要可能因来源更新而变化，任何决策都应以页面列出的官方文件和原文为准。
