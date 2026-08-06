"use client";

export type PredictionMarketId = "a-share" | "hk" | "us";

const markets: Array<{ id: PredictionMarketId; label: string; shortLabel: string }> = [
  { id: "a-share", label: "A股", shortLabel: "A股" },
  { id: "hk", label: "港股", shortLabel: "港股" },
  { id: "us", label: "美股", shortLabel: "美股" },
];

export default function PredictionMarketTabs({ active, onChange }: { active: PredictionMarketId; onChange: (id: PredictionMarketId) => void }) {
  return (
    <div className="prediction-market-tabs" role="tablist" aria-label="切换预测市场">
      {markets.map((market) => (
        <button
          key={market.id}
          type="button"
          role="tab"
          aria-selected={active === market.id}
          className={active === market.id ? "active" : ""}
          onClick={() => onChange(market.id)}
        >
          {market.label}
        </button>
      ))}
    </div>
  );
}
