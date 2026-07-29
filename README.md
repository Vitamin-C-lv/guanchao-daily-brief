# 观潮 · 每日市场情报

一个面向个人使用的响应式市场简报，覆盖美联储政策、A 股、港股、美股和近期财经热点。早间生成每日早报，交易日晚间补充 A/H 收盘、机构观点与板块轮动，每周五生成深度周报。页面按参考图采用浅紫灰背景、白色大卡片、黑色粗标题与柔和渐变；桌面端使用侧栏和多栏仪表盘，手机竖屏使用单列卡片、横滑市场卡和底部导航。

## 数据方式

本站不追求实时行情。页面简报来自 `content/daily-brief.json`，行业轮动指数来自 `content/sector-rotation.json`；A/H 定量输入先由 `scripts/market_evidence.py` 从稳定接口生成 `data/market-evidence/latest.json`，AI 负责核验、解释和新闻整合，不再负责从网页摘要猜数。每日只应用已冻结的经验模型做推理，再重新构建网站。

- 每条简报和热点都带原文引用，可点击跳转。
- 首页条目可进入精读页；每篇正文控制在 1000 字内，并按段标注引用，必要时附条形、发散条形、折线或分组条形等结构化数据图表。
- 三地市场分别使用各自最新完整交易日。
- A 股和港股每日固定分析板块轮动与可观察资金流向：采用一致行业口径，量价、ETF、市场广度、机构行为和事件字段逐项保存状态；缺失保留 `null`，接口失败不得填 0 或默认返回 50%。
- 行业轮动以 A 股、港股为主体；美股只保留纳斯达克、道琼斯、标普 500 三大指数。预测页分别使用独立的 1、5、20 交易日模型，主目标是“进入行业前 25%”，同时保存跑赢基准概率、绝对上涨概率和预期相对收益。
- 预测必须通过 walk-forward/purged 时间序列验证、embargo、Brier Skill、RankIC、Top-Bottom 扣费收益、横截面离散度与数据完整度门禁；差异不足或样本外无优势时主动弃权，页面改为明确标注的“证据观察榜”，绝不把观察分写成概率。
- 网站始终保持全球新闻、宏观与三地市场覆盖。恒生科技、港股互联网/AI/云计算、南向与相关 ETF，以及 A 股军工、医疗、半导体、AI/互联网只提高采集频率、深度、解释和历史留存，不获得任何人工加分或先验偏置。
- 经验模型只能由独立的强模型流程训练、样本外验证并版本化。每日早报和 20:00 收盘任务固定使用 GPT-5.6 Luna，只运行冻结模型推理；周五 GPT-5.6 Terra 内容周报只复盘表现和漂移，不能改模型；周六 08:00 的 GPT-5.6 Sol 极高推理审计才可训练候选，且仅在预登记、严格样本外和跨年度/市场状态门禁全部通过后替换冻结基线。
- 轮动模块严格区分已核验事实、数据商估算、概率预测与证据观察分；概率模型失效时显示具体弃权原因和仍可用证据，不编造南向/北向行业流或将大单算法直接描述成机构资金。
- 同花顺原始成交额与成交量标为 `vendor-market-data`；“主力资金”等算法字段标为 `vendor-estimate`，不能混为真实机构持仓。
- 需要实际获取 A 股行情、K 线、成交额/成交量、行业/题材和公告时，自动化可调用本机已安装的 `$a-stock-data`。行情优先 mootdx/腾讯，东财接口严格串行限流；社区技能说明仅是取数工具文档，不作为网站事实引用。
- 日报和周报的固定量价字段由 `pnpm market:data:daily` / `pnpm market:data:weekly` 采集：中证日频接口提供 25 个交易日行业量价与中证全指分母，中证样本表加目标日期一致的腾讯批量行情提供上涨广度与前三成交集中度；失败会逐字段记录日期、覆盖率和降级原因。完整说明见 `models/market-evidence/README.md`。
- 同花顺 `ths_hot_reason` 的成交额、成交量只代表当日个股样本。板块“明显放量”仍要求固定成分股、至少 25 个完整交易日同口径序列，并由交易所或另一行情源复核。
- 三套自动化共用 `.agents/skills/market-evidence-brief/` 的证据研究流程，每次固定扫描 Stanford HAI 2026 AI Index 官方报告及相关章节；无重大新增时不为凑数量写入页面。
- 每次生成新预测前复盘到期旧预测并记录正确、错误、中性、未到期、模型弃权或数据不足。每条发布快照写入本地 gzip JSONL 不可覆盖账本，实际结果单独补充；详情页使用当时真实发布值，禁止用最新模型事后重算。
- 数据图表只由结构化数值通过网页代码绘制。每日或每周最多可附一张 AI 生成编辑插图，但它只作主题表达，不能承载行情、数字、坐标轴或其他证据；生成失败不会阻断报告。
- 政策信息优先引用官方原文。
- 同花顺、东方财富可用于资讯发现、带直接链接的原始行情数据或交叉验证，重大结论仍回查官方公告或第二来源。
- 自动化编辑规则见 `content/AUTOMATION_PROMPT.md`。
- 交易日 20:00 由 `gpt-5.6-luna` 更新 A 股、港股收盘与当日机构/公司动态；规则见 `content/CLOSE_AUTOMATION_PROMPT.md`。
- 每周五 20:30 由 `gpt-5.6-terra` 读取周五收盘晚报及本周日报归档并检索全网，发布独立周报；规则见 `content/WEEKLY_AUTOMATION_PROMPT.md`。
- 每周六 08:00 由 `gpt-5.6-sol`、`xhigh` 推理审计到期的 5/20 交易日预测，必要时在独立候选目录调整来源、特征、权重或模型分类并训练；单周误差不会直接触发换模，规则见 `content/MODEL_REBUILD_AUTOMATION_PROMPT.md`。
- 周报发布后首次打开网站会显示更新摘要；日报只有当日确有重要度 90 分以上的重大新闻时才弹出一篇精选文章，否则不提醒。

## 本机轻量备份

每日内容校验通过后运行：

```powershell
pnpm archive:brief
```

压缩快照保存在 `data/archive/YYYY/MM/`，索引为 `data/archive/index.json`。归档保存结构化简报，并在文件存在时同包保存 `content/sector-rotation.json`；内容哈希覆盖简报与轮动结果，来源 URL 合并去重，同时兼容旧的 brief-only 快照。它不保存来源网页全文、图片、视频或网页副本；最多保留 400 份，总容量上限 50 MB，超限后自动从最旧记录开始清理。归档数据只保存在本机，默认不提交到 Git。

轮动事件记忆位于 `data/rotation-model/events/events.jsonl.gz`，按行流式压缩，只保存直达 URL、100–200 字事实摘要、行业/事件标签、已知时间、到期后验与哈希。非空后验还必须携带逐项交易日、版本化官方交易日历 URL 与 SHA-256；A 股会按本地日历 artifact 重算，港股在对应 artifact 缺失时保持空值。压缩文件 32 MB 硬上限、28 MB 开始清理；不保存新闻全文、PDF、上游图片或视频。历史行情和派生特征同样只保存在本机压缩目录并逐文件读取。

预测权威账本位于 Git 跟踪的 `data/prediction-ledger/`：每次发布快照与每次到期评价分别保存为不可覆盖、确定性 gzip JSON 事件，按年月组织并由月清单和根索引校验。`public/data/prediction-history/` 是完整、无内部字段、无条数上限的按月公开分片；`content/prediction-history.json` 仅是旧页面兼容视图。原 `data/rotation-model/predictions/` 只保留作一次性迁移来源，不再是权威数据。港股宏观结构化信号位于 `data/rotation-model/signals/hk-macro-daily.csv.gz`，两年数据仅几十 KB；HKMA/Federal Treasury 的接口失败、字段完整度和回退状态写入本地 manifest。

## 本地运行

需要 Node.js 20.9 或更高版本与 pnpm。

```powershell
pnpm install
pnpm dev
```

浏览器打开 `http://localhost:3000`。

## 内容与构建校验

```powershell
pnpm validate:rotation
pnpm validate:prediction-history
pnpm validate:prediction-ledger
pnpm test:prediction-ledger
pnpm validate:rotation-events
pnpm market:data:health
pnpm validate:market-data
pnpm validate:brief
pnpm assets:prune
pnpm validate:assets
pnpm typecheck
pnpm build
```

`next build` 会在 `out/` 生成可静态部署的网站。当前生产站点发布到 `https://guanchao-daily-brief.vercel.app/`，Vercel 已连接 GitHub 私人仓库；每次 `main` 分支推送都会自动生成新的生产部署。

## 自动化链路

```text
每日定时触发
  → 确定性取数工具先生成 A/H 逐字段证据包并检查日期、口径、覆盖率
  → AI 浏览和筛选可信来源
  → 共享证据技能分级来源、扫描 Stanford AI Index、复盘旧预测
  → 刷新 A/H 结构化输入、港股利率/汇率/流动性信号并应用冻结经验模型（不做每日训练）
  → 流式匹配/追加精简事件记忆，GPU 可选且失败自动降级 CPU
  → 交叉核验并生成中文摘要、结构化图表与可选编辑插图
  → 更新 content/daily-brief.json 与 content/sector-rotation.json
  → 追加不可覆盖预测快照并补充到期实际结果
  → 轮动/预测历史/事件/内容/生成资产校验 + 本机压缩归档
  → 类型检查 + 静态构建
  → Git 提交与推送
  → Vercel Git 自动生产发布
  → 固定网址 HTTP 与页面内容验证
```

Codex 自动化分别使用 `content/AUTOMATION_PROMPT.md`、`content/CLOSE_AUTOMATION_PROMPT.md`、`content/WEEKLY_AUTOMATION_PROMPT.md` 与 `content/MODEL_REBUILD_AUTOMATION_PROMPT.md`。首次上线前需配置 GitHub 远端并在 Vercel 连接该仓库；本地未配置远端时，自动化只会更新本机文件。

周六审计训练候选必须先构建并验证不可变 snapshot，再写入隔离的 candidate 输出；旧的可变训练与聚合入口已经移除，不会先抓取数据后才失败。冻结线上基线始终只读，只有通过提示词中的全部门禁后，独立审计流程才可以评估版本化升级。

## 预测训练数据快照

日常 `rotation:refresh` 只刷新免费行情与最新推理特征，绝不训练模型。A 股训练标签由 `scripts/prediction_dataset.py` 唯一生成：它以中证全指 `000985` 的显式交易日序列推进 1/5/20 个会话，并在固定 `a-core12-v2` 十二项横截面中计算绝对上涨、跑赢基准、前 25% 与预期超额收益。

训练必须先冻结内容寻址的不可变数据集快照；原始 history、features、signals 和日常缓存仍保持本机忽略，不纳入版本控制。快照本身连同 manifest、来源 hash、标签诊断和稳定 gzip panel 会纳入版本控制：

```powershell
uv run --no-project --python 3.12 --with requests --with numpy python scripts/sector_rotation.py features --history-dir <read-only-history-dir> --benchmark-history <read-only-history-dir>/000985.csv.gz --output-feature-file <staging-feature-file> --as-of 2026-07-21
uv run --no-project --python 3.12 --with requests --with numpy python scripts/prediction_dataset.py build --market a-share --feature-file <staging-feature-file> --history-dir <read-only-history-dir> --benchmark-history <read-only-history-dir>/000985.csv.gz --as-of 2026-07-21 --output-root models/sector-rotation/datasets --code-commit <commit>
uv run --no-project --python 3.12 --with requests --with numpy python scripts/prediction_dataset.py verify --snapshot models/sector-rotation/datasets/a-share/<dataset-id>
uv run --no-project --python 3.12 --with requests --with numpy python scripts/prediction_dataset.py inspect --snapshot models/sector-rotation/datasets/a-share/<dataset-id>
uv run --no-project --python 3.12 --with requests --with numpy python scripts/prediction_dataset.py diff --left <snapshot-a> --right <snapshot-b>
pnpm rotation:probability-train --dataset-snapshot models/sector-rotation/datasets/a-share/<dataset-id> --output models/sector-rotation/candidates/<shadow>.json
```

训练器只接受已验证 snapshot，拒绝把可变 `FEATURE_PATH` 当作隐式训练输入；输出也只能写入 audit candidate 目录。HK 尚未训练，US 尚未实现；本阶段不采集 ETF、南向、HIBOR、VIX 或任何付费数据源。

## 重要说明

本项目仅作信息整理，不构成投资建议。摘要可能因来源更新而变化，任何决策都应以页面列出的官方文件和原文为准。
