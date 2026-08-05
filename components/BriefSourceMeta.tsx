import { Clock3, Link2 } from "lucide-react";

function formatDate(value: string) {
  return value.replaceAll("-", ".");
}

export default function BriefSourceMeta({ dataAsOf, sourceCount }: { dataAsOf: string; sourceCount: number }) {
  return (
    <div className="brief-source-meta" aria-label={`数据截至 ${dataAsOf}，${sourceCount} 个来源`}>
      <span><Clock3 size={13} />数据截至 {formatDate(dataAsOf)}</span>
      <span><Link2 size={13} />{sourceCount} 个来源</span>
    </div>
  );
}
