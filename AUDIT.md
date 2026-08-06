# 阶段二工程审计

- 冻结基线：`main@9c8869fc3193a57e83ce46bde40c96c3aba8af41`
- 隔离 worktree：`D:\Guanchao-Workspace\worktrees\active\stage2-three-market-model-core`
- 分支：`feature/stage2-three-market-model-core`
- 原阶段包 ZIP SHA-256：`be72983b1684ae53417faf578ceab82099f95ed6703353431ac6e5736afb96d0`
- 集中修复包 ZIP SHA-256：`11d114d1cacd3d31bd5ed36323abe2221e90d986c41c729ab4000f2ce64c942`
- 修复后 source resolution SHA-256：`f2d82bb63ecd923ce3f7a2a56c190af253b8982b9950903c19251e0c509ecf15`；未重新搜索或替换供应商。

## 实施边界

`RUN_FETCH.ps1` 先生成私有 cache；`scripts/three_market_model_core.py` 只离线消费该 cache。统一 panel manifest 将 raw snapshot lineage 与 normalized panel identity 分离，保留 `null`，不把 USD/CNY 改为 USD/CNH，不把 HSTECH 回测值混入正式历史。主题对象没有合法稳定历史时保持 `unavailable`。

A 股复用现有 dataset contract 和 model-research 入口，仅生成 challenger comparison/recommendation；当前 champion 不替换。HK/US 研究输出固定为 shadow/abstained 或 insufficient-data，绝不写入文章、UI、Writer、日报/周报 automation、生产模型或 prediction ledger。

## 当前采集事实

集中修复包的 `fetch_fallbacks.py` 已写入既有私有 cache：`^IXIC`、Treasury 官方 yearly XML、`HKD=X`、HKMA liquidity 成功；`HSTECH.HK` 只返回 1 条真实 2026-08-06 观测，HKMA HIBOR chunked 首年度请求仍为 502。FRED 2Y/10Y/HKD cross-check 未成功时不阻塞 Treasury/HKD fallback。修复后的 payload-only validator 忽略 `meta.json`，支持 ISO、`YYYY/MM/DD`、`MM/DD/YYYY`，Cboe 不再误报日期无序。

本次运行态：A 股 dataset `ready`，champion/challenger 真实数值 OOS 比较完成并 `keep-champion`；HK dataset `partial`（HSI 1/5/20 strict OOS 完成，HSTECH 仅 1 条真实观测、1/5/20 `insufficient_data`，两个主题 `unavailable`，HIBOR direct endpoint unavailable，liquidity 已保留）；US Nasdaq dataset `ready`，Nasdaq 1/5/20 strict OOS 完成。HK/US 仍为 shadow/abstained，未发布概率。
