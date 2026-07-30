# research-bundle-v1 契约冻结

## 阶段与边界

P1-GA 只冻结 `research-bundle-v1` 的架构、数据边界、身份、来源政策和存储约定。后续顺序固定为 P1-GA（本契约）→ P1-GB（source catalog 与首批确定性 adapter）→ P1-GC（不可变 source run/document 存储、去重与 bundle 构建）→ P1-H（`writer-context-v1`）→ P1-I（自动 Luna、验证、P1-F apply 与发布）。

本阶段不采集网络数据、不实现 RSS/API/网页 adapter、HTML 正文提取、AI 事实抽取、自动 Luna、writer context/request 集成、定时工作流、页面、数据库或模型。research bundle 只组织来源、文档、观察、事件和覆盖状态；它不作投资结论，且不得修改模型、概率、`EvidenceScore`、排名、`publicationStatus`、发布门槛或 prediction ledger。

下游不得反向修改 source document。Luna 不得直接浏览或读取任意 `latest` 文件。`0` 是确认的零，`null` 是未获得；不得把缺失解释为零或静默当作无重要信息。运行审计时间不改变业务身份；同一身份同一内容幂等，同一身份不同内容 fail closed。

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

每个 `research-source-run-v1` 都有 `sourceId`、`provider`、`sourceClass`、`requestedAt`、`asOf`、`status`、`sourceUrl`、`marketScopes`、`topics`、`coverage`、`snapshotPolicy`、`rawSnapshotId` 和 `warnings`。`status` 只允许 `ready`、`partial`、`stale`、`unavailable`、`rate_limited`、`schema_changed`；`snapshotPolicy` 只允许 `stored`、`hash_only`、`none`。

`ready`、`partial`、`stale` 必须有 64 位小写 SHA-256 `rawSnapshotId`，且 policy 只能为 `stored` 或 `hash_only`。`unavailable`、`rate_limited`、`schema_changed` 必须为 `rawSnapshotId: null`、`snapshotPolicy: none`、`coverage.itemCount: 0` 并至少给出一条 warning。`coverage` 至少有非负整数 `itemCount` 和 `note`。`requestedAt` 只用于审计；`asOf` 为 ISO 时间或 `null`，不得伪造当前时间。

## 文档、观察、事件与重复关系

每个 `research-document-v1` 记录 `documentId`、来源、发布者、标题、HTTPS canonical URL、`publishedAt`、`accessedAt`、语言、内容类型、内容 SHA、raw snapshot SHA、市场、主题和 warnings。语言仅为 `zh`、`en`、`mixed`、`other`；内容类型仅为 `html`、`rss`、`atom`、`json`、`xml`、`pdf-metadata`、`press-release`、`filing`、`research-paper`、`social-post`、`community-post`。document 必须引用 bundle 内 source run，禁止搜索结果页；`publishedAt` 可为 `null`，但不可用抓取时间冒充。

文档只保存元数据与限定长度的证据片段，禁止完整正文、HTML、base64 或二进制。不得保存 cookies、token、认证头或个人数据，也不得下载或嵌入图片、视频和任意 PDF 二进制。

每个 observation 含 `observationId`、`kind`、主体、`statement`、`occurredAt`、`asOf`、市场、主题、实体、`evidenceState`、`basis`、warnings。`kind` 仅为 `hard-fact`、`official-statement`、`company-disclosure`、`market-event`、`calendar-event`、`analysis-context`、`counterevidence`。每条 basis 含 document ID、`supports|contradicts|context` relation、excerpt 与 locator；至少一条 `supports`，且每个 document 必须存在。statement 最多 400 字符、excerpt 最多 500、locator 最多 160；excerpt 仅保留最小必要证据，不能变相保存文章。时间不得晚于 bundle `asOf`，市场与主题不能为空，observation 禁止概率、排名或投资建议。

event 只组织已有 observations：它有确定性 `eventId`、类型、标题、时间、市场、主题和 observation IDs；至少引用一个已存在 observation，不增加新事实，也不含概率、预测或 importance 分数。重复 cluster 使用 `exact-url`、`content-hash`、`publisher-reprint`、`semantic-signature`；至少两个现有 documents，包含 canonical document，且一个 document 不得属于两个 cluster。后两者只标记关系，绝不删除或改写来源审计记录。

## 确定性 evidence state

`evidenceState` 的唯一允许值为 `confirmed`、`corroborated`、`single-source`、`conflicting`、`unverified`，按以下固定优先级从 basis 推导：

1. 只要有 `contradicts`，即为 `conflicting`。
2. 否则，只要有来自 `official-primary`、`company-filing`、`exchange-market-data` 或 `primary-research` 的 `supports`，即为 `confirmed`。
3. 否则，没有权威一手来源但有至少两个不同 publisher 的 supports，即为 `corroborated`。
4. 否则，全部 supports 仅来自 community/social signal，即为 `unverified`。
5. 其余单一 publisher 支持为 `single-source`。

同一 publisher 的不同 URL 不构成独立交叉验证。community/social signal 永远不能产生 `confirmed` 或 `corroborated`。AI 不得填写与此派生规则不一致的 evidence state，且社区或社交线索不得写成已确认事实。

## Bundle、覆盖与身份

`research-bundle-v1` 含 schema version、`daily|weekly` edition、`asOf`、`generatedAt`、窗口、source policy version、source runs、documents、observations、events、duplicate clusters、coverage、warnings、`bundleId`、integrity。窗口必须有 start/end/`Asia/Shanghai`，end 等于 asOf、start 不晚于 end。daily/weekly 都必须覆盖 `A_SHARE`、`HK`、`US`、`FED`；`GLOBAL` 只能补充。

数组按 `sourceId`、`documentId`、`observationId`、`eventId`、`clusterId` 稳定排序。coverage 分 markets、topics、totals；每个 market/topic 有 status、document/observation count 和 reasons，status 仅为 `ready|partial|unavailable`。所有计数必须与实际数组一致；`unavailable` 必有 reason，`partial` 必解释缺失或降级。`0` 是实际计数，不证明来源可用。

document ID 是规范化 `sourceId`、`canonicalUrl`、`publishedAt`、`contentSha256` 的 SHA-256；不含 accessedAt、warnings、本地路径或机器信息。observation 在 hash 前稳定排序 basis/markets/topics/entities，排除自身 ID、warnings 和审计时间。event 与 cluster 对规范化业务字段哈希。bundle 对规范化业务内容哈希；`generatedAt` 不参与，`integrity.businessSha256` 必须等于 `bundleId`。相同身份不同内容一律 fail closed。

`forbiddenKeys` 是键名禁令，而非普通文本关键词过滤；完整列表由机器可读注册表冻结。它禁止正文/HTML/二进制/认证材料，也禁止概率、收益、评分、排名、publication status、模型版本、预测、importance 和 sentiment 等越界业务字段。

## Raw snapshot 政策与合规

`stored` 仅允许官方 JSON/XML/RSS/Atom、政府公开发布、公司正式公告、交易所披露和允许公开再分发的结构化文件。`hash_only` 默认用于 major/specialist media、community、social 及版权不明确页面，仅保留 canonical URL、响应内容 SHA、标题与发布时间、最小证据片段、响应状态和抓取审计信息。`none` 用于 unavailable、rate limited、schema changed 或明确禁止抓取/存储的来源。

禁止登录、付费墙、CAPTCHA 或 WAF 绕过，禁止伪造 cookie、隐藏自动化身份和大规模保存新闻正文。官方结构化文件的不可变 snapshot 只能由后续 source policy 明确允许。

## 存储与未来 writer context

未来路径冻结为：

- `data/research-bundles/source-runs/YYYY/MM/<sourceRunId>.json.gz`
- `data/research-bundles/documents/YYYY/MM/<documentId>.json.gz`
- `data/research-bundles/bundles/YYYY/MM/<bundleId>.json.gz`
- `data/research-bundles/index.json`
- `content/research-bundles/daily-latest.json`
- `content/research-bundles/weekly-latest.json`

source run、document 和 bundle 永不覆盖；index/latest 是可重建派生视图。P1-GA 不创建空 index/latest、虚假 production bundle 或任何 gzip 数据文件。

research bundle 不可直接交给 Luna。P1-H 的 `writer-context-v1` 必须同时引用 immutable quantitative writer packet（schema version、artifact path/SHA、writerPacketId）、qualitative research bundle（schema version、artifact path/SHA、bundleId）和 baseline content（schema version、artifact path/SHA、contentIdentity），并绑定 `writerPromptSha256`、`targetSchemaVersion`、`validatorSha256`。它将扩展 ADR-012 与 P1-F 的 `writer-request-v1`，但保留 Luna 不得自主浏览的原则；本阶段绝不修改 P1-F 代码。
