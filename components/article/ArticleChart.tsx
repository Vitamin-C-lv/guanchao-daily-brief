import type { ArticleVisual } from "@/lib/types";
import ChartSourceNote from "./ChartSourceNote";
import LineComparisonChart from "./LineComparisonChart";
import ObservationScoreChart from "./ObservationScoreChart";
import SpreadChart from "./SpreadChart";
import YieldCurveChart from "./YieldCurveChart";

export default function ArticleChart({ visual }: { visual: ArticleVisual }) {
  const plot = () => {
    switch (visual.kind) {
      case "yield_curve":
        return <YieldCurveChart visual={visual} />;
      case "multi_line":
      case "line":
      case "area":
      case "indexed_performance":
        return <LineComparisonChart visual={visual} />;
      case "spread":
      case "bar":
      case "grouped_bar":
        return <SpreadChart visual={visual} />;
      case "comparison_table":
      case "timeline":
        return <ObservationScoreChart visual={visual} />;
      default:
        return <p className="article-chart-empty">暂不支持的图表类型</p>;
    }
  };
  return (
    <figure className="article-chart" aria-label={visual.title}>
      <figcaption>
        <strong className="article-chart-title">{visual.title}</strong>
        <span className="article-chart-takeaway">{visual.takeaway}</span>
      </figcaption>
      {plot()}
      <ChartSourceNote visual={visual} />
    </figure>
  );
}
