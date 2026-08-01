# P1-J 模型研究契约

P1-J 只研究 A 股固定 12 项观察池，并且只读取显式指定、已通过现有 validator 的不可变 prediction dataset snapshot。训练期间不得联网、不得寻找 latest、不得从网页或 prediction history 反拼标签、不得把空值填成 0，也不得改写生产模型、概率、排名、内容或 prediction ledger。

## 身份与数据边界

`model-candidate-v1` 的业务身份同时绑定 snapshot 相对路径、manifest SHA、dataset identity、taxonomy SHA、特征/目标契约、1/5/20 日 horizon、候选家族、超参数、训练/选择/审计窗口、研究代码 SHA、随机种子、校准方法与交易成本。开始/结束时间、机器路径、耗时和 warnings 只属于审计层，不参与候选身份。

数据审计必须先运行现有 immutable snapshot verifier，再检查 `(date, code)` 唯一性、稳定排序、完整横截面、非有限值、常量特征、同日重复特征向量、taxonomy/source manifest lineage，以及每个 horizon 的 `featureAsOf <= predictionDate < targetDate`。每个 walk-forward block 还必须满足 `trainingTargetDateMax < evaluationStart`。任何失败都使运行变成 `invalid-run`；数据窗口或标签类别不足则为 `insufficient-data`。

## 候选与选择纪律

候选采用预注册单因素设计，不做完整笛卡尔积，总数必须不超过 120：

- 当前 nonlinear 模型协议重放；
- logistic ridge `10/20/40/80/160`；
- regression ridge `20/40/80/160/320`；
- Platt calibrator ridge `0.5/1/2/4/8`；
- linear base、current nonlinear、逐 nonlinear group 消融；
- raw probability 与既有 Platt calibration。

选择只使用 holdout 之前的 purged、时间顺序 OOF/selection 窗口。5 日和 20 日 registry holdout 已在 2026-07-19 打开，因此只能标成已知最终审计，不能用于扩网格或反复调参；下一代 holdout 方案固定为 `future-only`。1 日窗口由本契约在看结果前固定为最后 252 个成熟日期，仍只允许本轮一次最终审计。

## 评估、晋级与影子推理

每个 horizon/target 输出 Brier、baseline Brier、Brier skill、log loss、AUC、校准斜率/截距、ECE、概率横截面标准差、观察数和日期数。排序层输出 rank IC、top-quartile hit rate、top-bottom 与扣费 spread、positive-window share、regime、最差 63 日块、累计 spread 最大回撤、turnover 和 abstention share；同时保留系数符号稳定性、系数离散、行业集中与 missingness sensitivity。

不确定性使用固定 seed、63 个交易日 block、1000 次 paired moving-block bootstrap。晋级必须先满足所有 lineage/leakage/holdout 门禁和冠军精确复现，再满足全 horizon 非劣与至少一个预注册主指标的正向证据。非劣边界在看结果前冻结：top-quartile Brier 最多增加 0.005、rank IC delta 不低于 -0.02、扣费 spread delta 不低于 -0.005、positive-window share delta 不低于 -0.10；这些边界不能绕过冠军精确复现硬门禁。生产冠军原始训练面板若未恢复，必须如实记录 `reproduction-unavailable` 并选择 `keep-champion`。

候选 artifact 可提交到 `models/sector-rotation/candidates/`；大型 OOF/bootstrap 明细只保存到外部恢复目录。`shadow-config.json` 永远 `active: false`。shadow 命令必须显式指定候选、verified feature snapshot 和仓库外输出；只返回 challenger/champion 概率、差值与 abstention 原因，不写任何生产状态。
