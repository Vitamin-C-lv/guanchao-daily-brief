# 阶段二工程审计

- 冻结基线：`main@9c8869fc3193a57e83ce46bde40c96c3aba8af41`
- 隔离 worktree：`D:\Guanchao-Workspace\worktrees\active\stage2-three-market-model-core`
- 分支：`feature/stage2-three-market-model-core`
- 附件 ZIP SHA-256：`be72983b1684ae53417faf578ceab82099f95ed6703353431ac6e5736afb96d0`
- 数据来源清单 SHA-256：`8a84b10878f603e697b368d6c9f36ff0507675f30525f97cc03397fc5015f0ed`；未重新搜索或替换供应商。

## 实施边界

`RUN_FETCH.ps1` 先生成私有 cache；`scripts/three_market_model_core.py` 只离线消费该 cache。统一 panel manifest 将 raw snapshot lineage 与 normalized panel identity 分离，保留 `null`，不把 USD/CNY 改为 USD/CNH，不把 HSTECH 回测值混入正式历史。主题对象没有合法稳定历史时保持 `unavailable`。

A 股复用现有 dataset contract 和 model-research 入口，仅生成 challenger comparison/recommendation；当前 champion 不替换。HK/US 研究输出固定为 shadow/abstained 或 insufficient-data，绝不写入文章、UI、Writer、日报/周报 automation、生产模型或 prediction ledger。

## 当前采集事实

本次冻结清单中 FRED 与 HKMA required endpoints 分别出现 read-timeout/502，Yahoo HSTECH 返回 404；这些失败保留为真实 `unavailable`。Cboe VIX、Yahoo HSI、Yahoo SOX 及 A 股交叉验证源成功落盘；附件自带 validation 脚本对 JSON 的 `meta.json` 选择和 Cboe `MM/DD/YYYY` 日期存在误报，实际行数/日期范围由离线 parser 复核并在 Review ZIP 的 `SOURCE_AUDIT.json` 中同时保留。

本次运行态：A 股 dataset `ready`；HK dataset `ready`（仅 HSI 非空，HSTECH/两个主题 `unavailable`）；US Nasdaq dataset `unavailable`。A 股 challenger 与 HK HSI 研究模型只保留 shadow/abstained，US 不训练。
