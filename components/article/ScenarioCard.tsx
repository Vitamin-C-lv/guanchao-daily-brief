export default function ScenarioCard({
  title,
  points,
  assets,
  invalidation,
}: {
  title: string;
  points: string[];
  assets: string[];
  invalidation: string;
}) {
  return (
    <section className="article-scenario" aria-label={`情景：${title}`}>
      <h4>{title}</h4>
      <ul>
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <p className="article-scenario-assets">最先反应：{assets.join("、")}</p>
      <p className="article-scenario-invalidation">推翻条件：{invalidation}</p>
    </section>
  );
}
