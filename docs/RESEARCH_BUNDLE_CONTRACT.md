# research-bundle-v1 契约冻结

## 阶段与边界

P1-G 冻结 `research-bundle-v1` 的架构、数据边界、身份、来源政策和存储约定，并在同一 frozen contract 上实现 source catalog、首批确定性 adapter、不可变 source run/document/raw/bundle 存储和 daily/weekly builder。后续顺序固定为 P1-H（`writer-context-v1`）→ P1-I（受控 writer execution、验证、P1-F apply 演练）。

首批只采集 Federal Reserve RSS、BLS RSS 和 Federal Register JSON 的官方元数据/结构化记录；不采集媒体、网页正文、HTML 正文提取、AI 事实抽取、自动 Luna、writer context/request 集成、定时工作流、页面、数据库或模型。research bundle 只组织来源、文档、观察、事件和覆盖状态；它不作投资结论，且不得修改模型、概率、`EvidenceScore`、排名、`publicationStatus`、发布门槛或 prediction ledger。

下游不得反向修改 source document。Luna 不得直接浏览或读取任意 `latest` 文件。`0` 是确认的零，`null` 是未获得；不得把缺失解释为零或静默当作无重要信息。业务身份不包含审计时间：未来写入层会重新验证首次 artifact，比较 business SHA 和 stable artifact view；仅允许的审计字段变化会复用首次 artifact 并返回 no-op，绝不覆盖。其余稳定业务字段不同一律 fail closed。

机器可读的冻结注册表是 [`data/research-bundles/contract.json`](../data/research-bundles/contract.json)。它不是 JSON Schema 框架，不引入 Ajv 或第二套实现。

## 来源与 source run

`sourceClass` 只允许以下可审计类别：

| 类别 | 含义 |
| --- | --- |
| `official-primary` | 政府、央行、统计机构、监管机构的原始发布。 |
| `company-filing` | 公司公告、交易所披露、投资者关系正式材料。 |
| `exchange-market-data` | 交易所、指数公司、官方市场数据。 |
| `primary-research` | 原始论文、研究机构正式报告和方法文件。 |
| `major-media` | 具有编辑责任和稳定发布体系的主流媒体。 |
| `specialist-media` | 专业垂直媒体，不能自动等同官方事实。 |
| `vendor-market-data` | 公开市场数据供应商。 |
| `vendor-estimate` | 供应商或机构估算，必须明确口径。 |
| `community-signal` | 论坛、社区和聚合讨论，只用于发现线索。 |
| `social-signal` | 公开社交账号信息，只作为线索或主体本人声明。 |

不得加入 `trusted`、`verified`、`reliable` 等无法审计的模糊类别。

每个 `research-source-run-v1` 都有 `sourceRunId`、`sourceId`、`provider`、`sourceClass`、`adapterId`、`adapterVersion`、`requestedAt`、`asOf`、`status`、`sourceUrl`、`marketScopes`、`topics`、`coverage`、`snapshotPolicy`、`rawSnapshotId`、`warnings` 和 `integrity`。`sourceId` 是 catalog 中稳定的来源标识；`sourceRunId` 是本次业务采集结果的不可变身份。`adapterId` 为小写 ASCII slug，`adapterVersion` 为 `v1` 起的递增版本；P1-GB 变更 adapter/parser 语义时必须产生新的 sourceRunId，绝不覆盖旧 document。`status` 只允许 `ready`、`partial`、`stale`、`unavailable`、`rate_limited`、`schema_changed`；`snapshotPolicy` 只允许 `stored`、`hash_only`、`none`。

`ready`、`partial`、`stale` 必须有 64 位小写 SHA-256 `rawSnapshotId`，且 policy 只能为 `stored` 或 `hash_only`。`unavailable`、`rate_limited`、`schema_changed` 必须为 `rawSnapshotId: null`、`snapshotPolicy: none`、`coverage.itemCount: 0` 并至少给出一条 warning。`coverage` 至少有非负整数 `itemCount` 和 `note`。全部 artifact timestamp 必须已经是严格的 `YYYY-MM-DDTHH:mm:ss.sssZ`；adapter 可用 `normalizeTimestamp` 接受带时区 ISO-8601 输入并在 seal 前转换，validator 不接受等价的 offset 文本。`asOf` 可为 `null`，不得伪造当前时间。

`sourceRunId` 是规范化 `sourceId`、`provider`、`sourceClass`、`adapterId`、`adapterVersion`、`asOf`、`status`、`sourceUrl`、去重并字典序排序的 `marketScopes`/`topics`、固定键顺序的 `coverage`、`snapshotPolicy` 与 `rawSnapshotId` 的小写 SHA-256。它排除 `sourceRunId`、`requestedAt`、`warnings`、`integrity`、本地路径和机器信息。`integrity.businessSha256 === sourceRunId`；`integrity.sha256` 对首次冻结的完整 canonical source run（排除自身 `integrity.sha256`）哈希。`requestedAt` 和 warnings 是唯一可变 audit-only 字段；stable artifact view 排除它们和 `integrity.sha256`。bundle 的 sourceRuns 必须按 `sourceRunId` 排序。

## 文档、观察、事件与重复关系

每个 `research-document-v1` 记录 `documentId`、`sourceRunId`、`sourceId`、`publisherId`、展示用 `publisher`、标题、HTTPS canonical URL、`publishedDate`、`publishedAt`、`accessedAt`、语言、内容类型、`contentHashBasis`、`contentHashVersion`、内容 SHA、raw snapshot SHA、市场、主题、warnings 和 `integrity`。`sourceRunId` 必须精确引用 bundle 中唯一、经验证且状态为 `ready|partial|stale` 的 source run，且 document `sourceId` 必须严格等于该 run 的 `sourceId`、document `rawSnapshotId` 必须严格等于该 run 的 `rawSnapshotId`；source class 只能由该 source run 解析，document 不得复制或覆盖。`publisherId` 是稳定小写 ASCII slug（`^[a-z0-9][a-z0-9._-]{1,79}$`）；展示名 `publisher` 不能用于独立性判断。语言仅为 `zh`、`en`、`mixed`、`other`；内容类型仅为 `html`、`rss`、`atom`、`json`、`xml`、`pdf-metadata`、`press-release`、`filing`、`research-paper`、`social-post`、`community-post`。只有日期时使用 `publishedDate` 且 `publishedAt: null`，精确来源时间同时保存原始明确日期和 canonical UTC timestamp；两者都可为 `null`，不可伪造午夜或抓取时间。

canonical URL 必须使用 WHATWG URL parser：scheme/hostname 小写、仅 HTTPS、移除 fragment 和默认 443 端口、空 path 归一为 `/`，保留 path 大小写、query 顺序与重复项，但不得猜测删除有业务语义的 path 或 query；来源特定 query 清理留给 P1-GB。认证信息、明确的 Google/Bing/Yahoo/Baidu/DuckDuckGo 搜索结果页均被拒绝。`contentHashBasis` 固定为 `response-entity`、`feed-item`、`structured-record` 或 `metadata-only`，`contentHashVersion` 固定 `v1`：前者按 HTTP content decoding 后、字符解码及正文解析前的响应实体字节计算；feed/structured record 使用来源 adapter 定义的确定性、版本化 canonical byte representation；metadata-only 仅用于 `pdf-metadata` 或明确禁止正文下载的来源，哈希规范化公开 metadata。不得用标题拼接字符串伪造内容 hash。

文档只保存元数据与限定长度的证据片段，禁止完整正文、HTML、base64 或二进制。不得保存 cookies、token、认证头或个人数据，也不得下载或嵌入图片、视频和任意 PDF 二进制。`feed-item` 只能配 `rss|atom`，`structured-record` 只能配 `json|xml`，`metadata-only` 只能配 `pdf-metadata`；`response-entity` 不得配 RSS、Atom 或 PDF metadata，且其内容 SHA 必须等于 source run 的 raw snapshot。`documentId` 是规范化 `sourceRunId`、`canonicalUrl`、`publishedDate`、`publishedAt`、`contentHashBasis`、`contentHashVersion`、`contentSha256` 的 SHA-256，排除 `documentId`、`accessedAt`、warnings、integrity、本地路径和机器信息；`integrity.businessSha256 === documentId`，而 `integrity.sha256` 对首次冻结的完整 canonical document（排除自身 `integrity.sha256`）哈希。`accessedAt` 和 warnings 是唯一可变 audit-only document 字段。

每个 observation 含 `observationId`、`kind`、主体、`statement`、`occurredAt`、`asOf`、市场、主题、实体、`evidenceState`、`basis`、warnings。`kind` 仅为 `hard-fact`、`official-statement`、`company-disclosure`、`market-event`、`calendar-event`、`analysis-context`、`counterevidence`。每条 basis 含 document ID、`supports|contradicts|context` relation、excerpt 与 locator；至少一条 `supports`，且每个 document 必须存在。statement 最多 400 字符、excerpt 最多 500、locator 最多 160；excerpt 仅保留最小必要证据，不能变相保存文章。市场与主题不能为空，observation 禁止概率、排名或投资建议。

observation identity 明确包含 kind、subject、statement、occurredAt、asOf、marketScopes、topics、entities、evidenceState、basis；排除自身 ID、warnings 和审计字段。marketScopes/topics 先去重字典序排序，entities 是最长 120 字符的非空字符串数组、去重后按稳定字符串标识排序，basis 按 documentId/relation/locator/excerpt 排序，且同一四元组不得重复。`observation.asOf` 为不晚于 bundle `asOf` 的 `YYYY-MM-DD`；`occurredAt` 为带时区 ISO-8601 或 `null`。非 calendar-event 的非空 occurredAt 不得晚于 asOf 对应上海时间 23:59:59；calendar-event 可晚于 asOf，仅当至少一个 supports 的 document 在该业务日结束前发布且 statement 明确描述已公布的未来日历，仍按常规 evidenceState 推导。

event 只组织已有 observations：它有确定性 `eventId`、类型、标题、时间、市场、主题和 observation IDs；identity 包含 eventType/title/occurredAt/去重排序 marketScopes/去重排序 topics/去重排序 observationIds。至少引用一个已存在 observation，不增加新事实，也不含概率、预测或 importance 分数；event occurredAt 必须遵守其引用 observations 的时间语义。重复 cluster identity 包含 method、canonicalDocumentId、去重排序 memberDocumentIds；v1 只有 `exact-url` 与 `content-hash`，后者必须同时相同 `contentHashBasis`、`contentHashVersion` 和 `contentSha256`。`publisher-reprint` 和 `semantic-signature` 保留给未来 v2，必须先冻结可验证的 signature/provenance 契约。一个 document 只能选择最高优先级的可证明方法进入一个 cluster。canonical document 选择最早 publishedAt；同值或均为 null 时选最小 documentId，null 排在有效发布时间之后。cluster 至少两个现有 documents，必须包含 canonical document。

## 确定性 evidence state

`evidenceState` 的唯一允许值为 `confirmed`、`corroborated`、`single-source`、`conflicting`、`unverified`，按以下固定优先级从 basis 推导：

1. 只要有来自 official-primary、company-filing、exchange-market-data、primary-research、major-media、specialist-media、vendor-market-data 或 vendor-estimate 的合格 `contradicts`，即为 `conflicting`；community/social 的 contradicts 仅是 unverified counter-signal。
2. 否则，只要有来自 `official-primary`、`company-filing`、`exchange-market-data` 或 `primary-research` 的 `supports`，即为 `confirmed`。
3. 否则，只有 `major-media`、`specialist-media`、`vendor-market-data`、`vendor-estimate` 可参与交叉验证；按稳定 `publisherId` 计数，去重后至少两个独立主体的 supports 才是 `corroborated`。
4. 否则，全部 supports 仅来自 community/social signal，即为 `unverified`。
5. 其余单一 publisher 支持为 `single-source`。

同一 `publisherId` 的不同 URL 只算一次；同一 duplicate cluster 的 documents 合计最多贡献一个 publisher，`publisher-reprint`/`semantic-signature` 不增加独立数。community/social signal 不参与 corroborated 计数，且永远不能产生 `confirmed` 或 `corroborated`。`confirmed` 仅表示权威一手材料直接支持 statement，不表示未来、因果或推断的绝对真理；analysis-context 只有准确描述来源的分析或方法时可 confirmed，不得升级为已证明市场因果。AI 不得填写与此派生规则不一致的 evidence state，且社区或社交线索不得写成已确认事实。

## Bundle、覆盖与身份

`research-bundle-v1` 含 schema version、`daily|weekly` edition、`asOf`、`generatedAt`、窗口、source policy version、source runs、documents、observations、events、duplicate clusters、coverage、warnings、`bundleId`、integrity。窗口必须有 start/end/`Asia/Shanghai`，end 等于 asOf、start 不晚于 end。daily/weekly 都必须覆盖 `A_SHARE`、`HK`、`US`、`FED`；`GLOBAL` 只能补充。

数组按 `sourceRunId`、`documentId`、`observationId`、`eventId`、`clusterId` 稳定排序。bundle ID 不能直接 hash 完整 bundle：它只 hash 递归 business view，即 schemaVersion、edition、asOf、window、sourcePolicyVersion、排序的 sourceRunIds/documentIds、observations/events/duplicate clusters 的业务视图及 coverage；不得含 generatedAt、warnings、integrity、source run requestedAt、document accessedAt、任何完整审计字段、本地路径或机器信息。完整对象仍可嵌入 sourceRuns/documents。`integrity` 必有 `businessSha256` 与 `sha256`；前者等于 bundleId，后者对首次冻结的完整 canonical bundle（排除自身 `integrity.sha256`）哈希。`generatedAt` 和 bundle warnings 是唯一 audit-only 字段；相同 business ID 的 candidate 仅在 stable artifact view 也相同时复用首次 artifact，否则 fail closed。

coverage 分 markets、topics、totals；每项 market/topic 分别必有 market/topic、status、documentCount、observationCount、reasons，status 仅为 `ready|partial|unavailable`。markets 按 enum 顺序恰好各有一项 `A_SHARE`、`HK`、`US`、`FED`，可有零或一项 `GLOBAL`；topics 不重复、按 enum 排序并至少包含 bundle 已出现 topics。market/topic 的 documentCount 与 observationCount 分别是其 scope/topic 数组包含该值的唯一 ID 数量；不同类别可重叠，禁止求和后与顶层数组长度比较。totals 必须直接等于对应数组长度，`conflictingObservations` 是 conflicting observation 数。`unavailable`/`partial` 必有 reasons，`ready` 的 reasons 必为空数组。`0` 是实际计数，不证明来源可用。

document、observation、event、cluster 与 bundle 的确定性公式与排序规则以注册表为准；所有同一身份不同内容均 fail closed。

`forbiddenKeys` 是键名禁令，而非普通文本关键词过滤；完整列表由机器可读注册表冻结。它禁止正文/HTML/二进制/认证材料，也禁止概率、收益、评分、排名、publication status、模型版本、预测、importance 和 sentiment 等越界业务字段。

## Raw snapshot 政策与合规

`stored` 仅允许官方 JSON/XML/RSS/Atom、政府公开发布、公司正式公告、交易所披露和允许公开再分发的结构化文件。`hash_only` 默认用于 major/specialist media、community、social 及版权不明确页面，仅保留 canonical URL、响应内容 SHA、标题与发布时间、最小证据片段、响应状态和抓取审计信息。`none` 用于 unavailable、rate limited、schema changed 或明确禁止抓取/存储的来源。

禁止 robots 规则或明确网站条款禁止的自动访问、登录、付费墙、CAPTCHA 或 WAF 绕过，禁止伪造 cookie/认证、隐藏自动化身份、保存个人敏感数据和大规模保存新闻正文。robots 或条款禁止时必须 `snapshotPolicy: none`、status 为实际 `unavailable`，warning 说明政策性不可采集；不得标为 `schema_changed`。官方结构化文件的不可变 snapshot 只能由后续 source policy 明确允许。

## 存储与未来 writer context

未来路径冻结为：

- `data/research-bundles/raw/YYYY/MM/<rawSnapshotId>.bin.gz`
- `data/research-bundles/source-runs/YYYY/MM/<sourceRunId>.json.gz`
- `data/research-bundles/documents/YYYY/MM/<documentId>.json.gz`
- `data/research-bundles/bundles/YYYY/MM/<bundleId>.json.gz`
- `data/research-bundles/index.json`
- `content/research-bundles/daily-latest.json`
- `content/research-bundles/weekly-latest.json`

raw source run、document 和 bundle 永不覆盖；index/latest 是可重建派生视图。真实运行以 deterministic gzip（mtime=0）写入，dry-run 完成 fetch/parse/seal/validate/写入计划但绝不在仓库创建 artifact；不提交空 index/latest、虚假 production bundle 或任何 gzip 数据文件。

每个 storage plan 都明确给出 `file`、`bytes`、`created`、`reused`、`shouldWrite`、`kind`。新 artifact 才允许 `created: true, reused: false, shouldWrite: true`；完全相同或仅 audit-only 字段变化时必须复用首次冻结字节，返回 `created: false, reused: true, shouldWrite: false`。raw、source run、document、bundle、index 与 latest 在 `shouldWrite: false` 时都不得调用写入，也不得改变 mtime。summary 的 `wouldWrite` 只列实际计划写入的路径。

document 存储年月显式接收 bundle `asOf`：优先使用来源 `publishedDate`；只有 `publishedAt` 时转成 Asia/Shanghai 业务日期；两者都缺失时仅将 bundle `asOf` 用作物理分区，不向 document 伪造 `asOf`。bundle 窗口仍排除无有效发布日期的 document，index 则如实保留 `publishedDate: null`。

rebuild 在规划 index/latest 之前递归扫描 `raw/**/*.bin.gz`。raw 文件名必须是其解压字节的 64 位小写 SHA-256，gzip 必须可解压，同一 raw ID 只能有一个物理路径；`ready|partial|stale` source run 及所有 document 的 raw 必须存在并与 source run 精确一致，失败状态不得引用 raw。任一 raw/source/document/bundle 校验失败时，现有 index/latest 保持原字节和 mtime。

duplicate canonical 的唯一共享比较器按 effective publication 排序：业务日期升序；同日精确 `publishedAt` 早于 date-only；timestamp-only 先换算上海日期；null-date 最后；最终以 `documentId` 断平。builder 和 validator 调用同一实现。带 offset 的 feed timestamp 同时保留来源日历 `publishedDate` 和 canonical UTC `publishedAt`。

provider warning 只能是稳定、受控且不含响应正文、headers、cookie、token、堆栈或敏感 query 的诊断，如 `http-status-403`、`timeout`、`network-failure`、`content-type-text-html`、`response-too-large`、`xml-root-invalid`、`json-count-invalid`。这些 warning、最终 hostname 和 document 数只进入 dry-run `sourceDiagnostics`，不进入业务身份。Federal Register 的 `{ "count": 0, "results": [] }` 是合法 `ready` 零结果。

collection CLI 默认不写，`run` 必须且只能选择 `--dry-run` 或 `--write`；缺失或同时提供两个模式都以 `PIPELINE_ARGUMENT` fail closed。`--write` 只用于明确审核后的目标或隔离 temp/sandbox，验收不得在真实开发 worktree 执行。

P1-G 的唯一 canonical identity 与验证器是 [`scripts/research-contract.mjs`](../scripts/research-contract.mjs)：它提供 canonical JSON、SHA-256、URL 规范化、business/stable artifact view、ID、evidenceState、共享 publication comparator 和严格结构/语义验证。只读 CLI 为 `node scripts/research-contract.mjs validate-registry` 与 `node scripts/research-contract.mjs validate-bundle --file <path>`；后者不访问网络、不写文件、不读取 gzip 或目录。唯一 collection pipeline 是 [`scripts/research-pipeline.mjs`](../scripts/research-pipeline.mjs)：catalog validation、bounded official fetch、RSS/Atom/Federal Register parse、immutable storage、raw-aware rebuild 和 dry-run 都在此文件；它不包含 service/repository/manager 层，也不写任何正文或 AI observation。

research bundle 不可直接交给 Luna。`writer-context-v1` 同时引用 immutable quantitative writer packet（schema version、artifact path/SHA、writerPacketId）、qualitative research bundle（schema version、artifact path/SHA、bundleId）和 baseline content（schema version、artifact path/SHA、contentIdentity），并绑定 prompt、target schema 与 validator 的路径和 SHA。`writer-request-v2` 只绑定这个显式 context；Luna 仅接收封闭 execution package，不得浏览、搜索、调用 API 或读取 latest。
