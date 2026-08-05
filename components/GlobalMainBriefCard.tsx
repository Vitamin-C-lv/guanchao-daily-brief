import { ArrowUpRight, Sparkles } from "lucide-react";
import Link from "next/link";
import BriefSourceMeta from "./BriefSourceMeta";
import LogicChainPreview from "./LogicChainPreview";
import type { GlobalMainBriefPublic, GlobalMarketTag } from "@/lib/global-market-brief-public";

const marketLabels: Record<GlobalMarketTag, string> = {
  US: "美股",
  HK: "港股",
  A_SHARE: "A股",
  GLOBAL: "全球",
};

export default function GlobalMainBriefCard({ brief, variant = "featured" }: { brief: GlobalMainBriefPublic; variant?: "featured" | "detail" }) {
  const Heading = variant === "detail" ? "h1" : "h2";
  return (
    <article className={`global-main-brief-card global-main-brief-card-${variant}`}>
      <div className="global-main-brief-topline">
        <span className="global-main-brief-kicker"><Sparkles size={14} />今日全球判断</span>
        <BriefSourceMeta dataAsOf={brief.dataAsOf} sourceCount={brief.sourceCount} />
      </div>

      <div className="global-main-brief-body">
        <div className="global-main-brief-copy">
          <Heading className="global-main-brief-title">{brief.title}</Heading>
          <p className="global-main-brief-dek">{brief.dek}</p>
        </div>
        <div className="global-main-brief-conclusion">
          <span>主结论</span>
          <p>{brief.conclusion}</p>
        </div>
      </div>

      <LogicChainPreview logicChain={brief.logicChainSummary} />

      <div className="global-main-brief-footer">
        <div className="global-market-tags" aria-label="涉及市场">
          <span className="global-market-tags-label">涉及市场</span>
          {brief.marketTags.map((tag) => <span className="global-market-tag" key={tag}>{marketLabels[tag]}</span>)}
        </div>
        <Link className="global-main-brief-link" href={brief.articleUrl}>
          阅读全球主文章 <ArrowUpRight size={15} />
        </Link>
      </div>
    </article>
  );
}
