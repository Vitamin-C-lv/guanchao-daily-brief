import type { SourceEvidenceClass, SourceLink as SourceLinkData } from "@/lib/types";

const tierLabels: Record<SourceLinkData["tier"], string> = {
  official: "官方",
  authoritative: "权威",
  "major-media": "主流媒体",
};

const evidenceClassLabels: Record<SourceEvidenceClass, string> = {
  "official-primary": "官方一手",
  "company-filing": "公司披露",
  "primary-research": "原始研究",
  "exchange-market-data": "交易所行情",
  "vendor-market-data": "商业行情",
  "vendor-estimate": "供应商估算",
  "major-media": "媒体报道",
};

export function sourceTierLabel(tier: SourceLinkData["tier"]) {
  return tierLabels[tier];
}

export function sourceEvidenceClassLabel(evidenceClass?: SourceEvidenceClass) {
  return evidenceClass ? evidenceClassLabels[evidenceClass] : null;
}

export function sourceMetaLabel(source: Pick<SourceLinkData, "publisher" | "tier" | "evidenceClass">) {
  return [source.publisher, sourceTierLabel(source.tier), sourceEvidenceClassLabel(source.evidenceClass)]
    .filter(Boolean)
    .join(" · ");
}

export function SourceMeta({ source }: { source: Pick<SourceLinkData, "publisher" | "tier" | "evidenceClass"> }) {
  const evidenceLabel = sourceEvidenceClassLabel(source.evidenceClass);
  return (
    <small>
      {source.publisher} · {sourceTierLabel(source.tier)}
      {evidenceLabel ? <> · <span title="证据类别">{evidenceLabel}</span></> : null}
    </small>
  );
}
