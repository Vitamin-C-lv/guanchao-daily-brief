# research-bundle-v1 契约冻结

## 阶段与边界

P1-GA 只冻结 `research-bundle-v1` 的架构、数据边界、身份、来源政策和存储约定。后续顺序固定为 P1-GA（本契约）→ P1-GB（source catalog 与首批确定性 adapter）→ P1-GC（不可变 source run/document 存储、去重与 bundle 构建）→ P1-H（`writer-context-v1`）→ P1-I（自动 Luna、验证、P1-F apply 与发布）。

本阶段不采集网络数据、不实现 RSS/API/网页 adapter、HTML 正文提取、AI 事实抽取、自动 Luna、writer context/request 集成、定时工作流、页面、数据库或模型。research bundle 只组织来源、文档、观察、事件和覆盖状态；它不作投资结论，且不得修改模型、概率、`EvidenceScore`、排名、`publicationStatus`、发布门槛或 prediction ledger。

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

`ready`、`partial`、`stale` 必须有 64 位小写 SHA-256 `rawSnapshotId`，且 policy 只能为 `stored` 或 `hash_only`。`unavailable`、`rate_limited`、`schema_changed` 必须为 `rawSnapshotId: null`、`snapshotPolicy: none`、`coverage.itemCount: 0` 并至少给出一条 warning。`coverage` 至少有非负整数 `itemCount` 和 `note`。`requestedAt` 是带时区 ISO-8601 审计时间；`asOf` 是带时区 ISO-8601 时间或 `null`，不得伪造当前时间。

`sourceRunId` 是规范化 `sourceId`、`provider`、`sourceClass`、`adapterId`、`adapterVersion`、`asOf`、`status`、`sourceUrl`、去重并字典序排序的 `marketScopes`/`topics`、固定键顺序的 `coverage`、`snapshotPolicy` 与 `rawSnapshotId` 的小写 SHA-256。它排除 `sourceRunId`、`requestedAt`、`warnings`、`integrity`、本地路径和机器信息。`integrity.businessSha256 === sourceRunId`；`integrity.sha256` 对首次冻结的完整 canonical source run（排除自身 `integrity.sha256`）哈希。`requestedAt` 和 warnings 是唯一可变 audit-only 字段；stable artifact view 排除它们和 `integrity.sha256`。bundle 的 sourceRuns 必须按 `sourceRunId` 排序。

## 文档、观察、事件与重复关系

每个 `research-document-v1` 记录 `documentId`、`sourceRunId`、`sourceId`、`publisherId`、展示用 `publisher`、标题、HTTPS canonical URL、`publishedAt`、`accessedAt`、语言、内容类型、`contentHashBasis`、`contentHashVersion`、内容 SHA、raw snapshot SHA、市场、主题、warnings 和 `integrity`。`sourceRunId` 必须精确引用 bundle 中唯一 source run，且 document `sourceId` 必须严格等于该 run 的 `sourceId`；source class 只能由该 source run 解析，document 不得复制或覆盖。`publisherId` 是稳定小写 ASCII slug（`^[a-z0-9][a-z0-9._-]{1,79}$`）；展示名 `publisher` 不能用于独立性判断。语言仅为 `zh`、`en`、`mixed`、`other`；内容类型仅为 `html`、`rss`、`atom`、`json`、`xml`、`pdf-metadata`、`press-release`、`filing`、`research-paper`、`social-post`、`community-post`。`publishedAt` 为带时区 ISO-8601 时间或 `null`，不可用抓取时间冒充；`accessedAt` 必须为带时区 ISO-8601 时间。

canonical URL 必须使用 WHATWG URL parser：scheme/hostname 小写、仅 HTTPS、移除 fragment 和默认 443 端口、空 path 归一为 `/`，保留 path 大小写、query 顺序与重复项，但不得猜测删除有业务语义的 path 或 query；来源特定 query 清理留给 P1-GB。认证信息、明确的 Google/Bing/Yahoo/Baidu/DuckDuckGo 搜索结果页均被拒绝。`contentHashBasis` 固定为 `response-entity`、`feed-item`、`structured-record` 或 `metadata-only`，`contentHashVersion` 固定 `v1`：前者按 HTTP content decoding 后、字符解码及正文解析前的响应实体字节计算；feed/structured record 使用来源 adapter 定义的确定性、版本化 canonical byte representation；metadata-only 仅用于 `pdf-metadata` 或明确禁止正文下载的来源，哈希规范化公开 metadata。不得用标题拼接字符串伪造内容 hash。

文档只保存元数据与限定长度的证据片段，禁止完整正文、HTML、base64 或二进制。不得保存 cookies、token、认证头或个人数据，也不得下载或嵌入图片、视频和任意 PDF 二进制。`documentId` 是规范化 `sourceRunId`、`canonicalUrl`、`publishedAt`、`contentHashBasis`、`contentHashVersion`、`contentSha256` 的 SHA-256，排除 `documentId`、`accessedAt`、warnings、integrity、本地路径和机器信息；`integrity.businessSha256 === documentId`，而 `integrity.sha256` 对首次冻结的完整 canonical document（排除自身 `integrity.sha256`）哈希。`accessedAt` 和 warnings 是唯一可变 audit-only document 字段。

每个 observation 含 `observationId`、`kind`、主体、`statement`、`occurredAt`、`asOf`、市场、主题、实体、`evidenceState`、`basis`、warnings。`kind` 仅为 `hard-fact`、`official-statement`、`company-disclosure`、`market-event`、`calendar-event`、`analysis-context`、`counterevidence`。每条 basis 含 document ID、`supports|contradicts|context` relation、excerpt 与 locator；至少一条 `supports`，且每个 document 必须存在。statement 最多 400 字符、excerpt 最多 500、locator 最多 160；excerpt 仅保留最小必要证据，不能变相保存文章。市场与主题不能为空，observation 禁止概率、排名或投资建议。

observation identity 明确包含 kind、subject、statement、occurredAt、asOf、marketScopes、topics、entities、evidenceState、basis；排除自身 ID、warnings 和审计字段。marketScopes/topics 先去重字典序排序，entities 是最长 120 字符的非空字符串数组、去重后按稳定字符串标识排序，basis 按 documentId/relation/locator/excerpt 排序，且同一四元组不得重复。`observation.asOf` 为不晚于 bundle `asOf` 的 `YYYY-MM-DD`；`occurredAt` 为带时区 ISO-8601 或 `null`。非 calendar-event 的非空 occurredAt 不得晚于 asOf 对应上海时间 23:59:59；calendar-event 可晚于 asOf，仅当至少一个 supports 的 document 在该业务日结束前发布且 statement 明确描述已公布的未来日历，仍按常规 evidenceState 推导。

event 只组织已有 observations：它有确定性 `eventId`、类型、标题、时间、市场、主题和 observation IDs；identity 包含 eventType/title/occurredAt/去重排序 marketScopes/去重排序 topics/去重排序 observationIds。至少引用一个已存在 observation，不增加新事实，也不含概率、预测或 importance 分数；event occurredAt 必须遵守其引用 observations 的时间语义。重复 cluster identity 包含 method、canonicalDocumentId、去重排序 memberDocumentIds，方法依次为 `exact-url`、`content-hash`、`publisher-reprint`、`semantic-signature`；一个 document 只能选择最高优先级的可证明方法进入一个 cluster。canonical document 选择最早 publishedAt；同值或均为 null 时选最小 documentId，null 排在有效发布时间之后。cluster 至少两个现有 documents，必须包含 canonical document；后两类只标记关系，绝不删除或改写来源审计记录。

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

- `data/research-bundles/source-runs/YYYY/MM/<sourceRunId>.json.gz`
- `data/research-bundles/documents/YYYY/MM/<documentId>.json.gz`
- `data/research-bundles/bundles/YYYY/MM/<bundleId>.json.gz`
- `data/research-bundles/index.json`
- `content/research-bundles/daily-latest.json`
- `content/research-bundles/weekly-latest.json`

source run、document 和 bundle 永不覆盖；index/latest 是可重建派生视图。P1-GA 不创建空 index/latest、虚假 production bundle 或任何 gzip 数据文件。

P1-GA 的唯一 canonical identity 与验证器是 [`scripts/research-contract.mjs`](../scripts/research-contract.mjs)：它提供 canonical JSON、SHA-256、URL 规范化、business/stable artifact view、ID、evidenceState 和严格结构/语义验证。只读 CLI 为 `node scripts/research-contract.mjs validate-registry` 与 `node scripts/research-contract.mjs validate-bundle --file <path>`；后者不访问网络、不写文件、不读取 gzip 或目录。P1-GA 最终包包含契约与该验证器/定向测试，仍不包含采集器、adapter、source run/document/bundle 落盘或任何 production 数据。

research bundle 不可直接交给 Luna。P1-H 的 `writer-context-v1` 必须同时引用 immutable quantitative writer packet（schema version、artifact path/SHA、writerPacketId）、qualitative research bundle（schema version、artifact path/SHA、bundleId）和 baseline content（schema version、artifact path/SHA、contentIdentity），并绑定 `writerPromptSha256`、`targetSchemaVersion`、`validatorSha256`。它将扩展 ADR-012 与 P1-F 的 `writer-request-v1`，但保留 Luna 不得自主浏览的原则；本阶段绝不修改 P1-F 代码。
