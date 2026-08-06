export default function PredictionSourceNote({ marketId }: { marketId: string }) {
  const marketNote = marketId === "hk"
    ? "港股当前：恒生指数模型已训练但未通过发布门槛；恒生科技指数样本不足；两个主题对象数据不可用。全部不显示概率。"
    : marketId === "us"
      ? "美股当前：纳斯达克综合指数为研究候选，1/5/20 日均未通过发布门槛。20 日研究指标较好也不得解释为可发布模型。"
      : "A股当前：模型已训练但未通过概率质量门槛，页面只展示规则观察榜；证据分不是上涨概率。";
  return (
    <section className="prediction-source-note" aria-label="数据与概率说明">
      <strong>关于概率与观察</strong>
      <p>只有通过样本外门槛的模型才显示概率；弃权与数据不足不会被伪装成概率。历史基准率不是当前模型概率；观察分是证据分，不是概率。</p>
      <p>{marketNote}</p>
    </section>
  );
}
