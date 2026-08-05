# P2-B 并行任务边界

## 冻结基线与总顺序

- `taskId`: `P2-B0`
- `baselineMainSha`: `e82f48a6f9b7c8e3a801b089c199187958f4ae16`
- `contract`: `global-market-brief-v1`
- `currentBranch`: `feature/p2-b0-global-brief-contract`
- `currentWorktree`: `D:\Guanchao-Workspace\worktrees\active\p2-b0-global-brief-contract`
- `mergeOrder`: `B0 → B1/B2/B3 并行 → B4 集成；B1/B2/B3 必须从 B0 合并后的 `main` 重新建立各自 worktree 和 `baselineMainSha`。
- `automation`: 所有 automation 保持暂停；自动化恢复不属于 B1/B2/B3。

P2-B0 独占以下冻结热点文件：`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/ADR.md`、`package.json`、`schemas/global-market-brief-v1.schema.json`、`schemas/global-market-brief-public-dto-v1.schema.json`、`schemas/global-market-event-v1.schema.json`、`scripts/global-market-brief-contract.mjs` 及其 fixture/test。B1 独占 Writer 主契约，B3 独占首页与简报页主组件；任何 lane 不得修改其他 lane 的热点文件。

## Lane P2-B1

```yaml
taskId: P2-B1
baselineMainSha: "P2-B0 merge SHA on main (record before dispatch)"
allowedFiles:
  - data/research-bundles/**
  - data/writer-contexts/**
  - data/writer-jobs/**
  - scripts/research-*.mjs
  - scripts/writer-*.mjs
  - scripts/codex-writer-*.mjs
  - scripts/validate-*.mjs
  - scripts/editorial-lint.mjs
  - prompts/**
  - schemas/global-market-brief-writer-output-v1.schema.json
forbiddenFiles:
  - docs/HANDOFF.md
  - docs/ARCHITECTURE.md
  - docs/ADR.md
  - package.json
  - schemas/global-market-brief-v1.schema.json
  - schemas/global-market-brief-public-dto-v1.schema.json
  - schemas/global-market-event-v1.schema.json
  - scripts/global-market-brief-contract.mjs
  - app/**
  - components/**
  - content/daily-brief.json
  - models/**
  - data/prediction-ledger/**
inputContract:
  - immutable research-bundle-v1
  - immutable quantitative writer packet
  - immutable baseline content
  - global-market-brief-v1 output and trigger eligibility rules
outputContract:
  - writer-context/request/result transition with one global_main and zero-to-two special_report outputs
  - validator and editorial lint errors containing article id and field path
dependencies:
  - P2-B0 merged to main
  - P2-B2 quality rules available as a reviewed external/local input
requiredTests:
  - existing research contract
  - writer context/request/job
  - content validator and editorial lint
  - new global contract test remains green
temporaryReportBundleName: p2-b1-writer-integration-handoff
```

## Lane P2-B2

```yaml
taskId: P2-B2
baselineMainSha: "P2-B0 merge SHA on main (record before dispatch)"
allowedFiles:
  - C:\Users\18442\.codex\skills\guanchao-financial-writer\**
  - D:\周报个人网站-local-writer-runtime\**
  - external quality-rule report files outside the repository
forbiddenFiles:
  - repository private Skill正文提交
  - .agents/skills/**
  - docs/HANDOFF.md
  - docs/ARCHITECTURE.md
  - docs/ADR.md
  - package.json
  - content/**
  - data/**
  - app/**
  - components/**
  - models/**
inputContract:
  - global-market-brief-v1 semantics
  - frozen writer input/output boundary
  - local logged-in Codex only; no external LLM API, token, cookie or autonomous browsing
outputContract:
  - reviewed quality-rule findings and local Skill/runtime handoff
  - no repository Skill正文 and no production content
dependencies:
  - P2-B0 merged to main
  - P2-B1 writer target contract available for compatibility review
requiredTests:
  - Skill static/quality rule checks
  - bounded writer dry-run with wrote=false and productionApply.applied=false
  - unchanged production boundary hash check
temporaryReportBundleName: p2-b2-writer-quality-handoff
```

## Lane P2-B3

```yaml
taskId: P2-B3
baselineMainSha: "P2-B0 merge SHA on main (record before dispatch)"
allowedFiles:
  - app/page.tsx
  - app/briefs/page.tsx
  - app/articles/[id]/page.tsx
  - components/**
  - lib/global-market-brief-public.ts
  - public/** (only if the reviewed page contract requires a non-content asset)
forbiddenFiles:
  - docs/HANDOFF.md
  - docs/ARCHITECTURE.md
  - docs/ADR.md
  - package.json
  - schemas/**
  - scripts/**
  - data/research-bundles/**
  - data/writer-contexts/**
  - data/writer-jobs/**
  - content/daily-brief.json
  - content/writer-*
  - models/**
inputContract:
  - global-market-brief-public-dto-v1
  - main card fields and special report card fields only
outputContract:
  - homepage/global main article card
  - briefs list global main article card and zero-to-two special report area
  - no provider/internal lineage/debug fields in React props or rendered DTO
dependencies:
  - P2-B0 merged to main
  - P2-B1 public output fixture and DTO adapter reviewed
requiredTests:
  - typecheck
  - page/component tests available in the repository
  - static build
  - public DTO forbidden-field test
temporaryReportBundleName: p2-b3-global-brief-ui-handoff
```

## P2-B4 集成门

- B4 是最终集成 owner；只接收 B1/B2/B3 各自的 temporary report bundle 和 Draft PR，不在 B1/B2/B3 之间做隐式文件共享。
- 合并前必须确认 B0 的 schema/fixture/test、P2-B1 的 Writer 绑定、P2-B2 的质量规则和 P2-B3 的公开 DTO 字段一致；生产 `daily-brief-v1` 只在统一切换评审通过后删除。
- B4 不训练港股、不发布港股概率、不恢复 automation、不引入数据库/向量库/图数据库/知识图谱/新搜索服务。
