import type { ArticleVisual } from "@/lib/types";

export default function ChartSourceNote({ visual }: { visual: ArticleVisual }) {
  return (
    <div className="article-chart-note">
      <span>单位：{visual.unit}</span>
      <span>数据截至：{visual.dataThrough}</span>
      <span>来源：[{visual.sourceIndexes.join(", ")}]</span>
      {visual.notes.map((note) => (
        <span key={note}>{note}</span>
      ))}
    </div>
  );
}
