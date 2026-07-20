import { ArrowRight, BarChart3 } from "lucide-react";
import Link from "next/link";
import type { MarketObserverSnapshot } from "@/lib/types";

export default function MarketObserverTeaser({ data }: { data: MarketObserverSnapshot }) {
  if (!data.homeObservation.significant) return null;
  const rows = [
    ["数据", data.homeObservation.data],
    ["宏观", data.homeObservation.macro],
    ["反证", data.homeObservation.counterEvidence],
    ["观察", data.homeObservation.watch],
  ];
  return (
    <section className="market-observer-teaser" aria-labelledby="market-observer-teaser-title">
      <div className="observer-teaser-mark"><BarChart3 size={18} /></div>
      <div className="observer-teaser-content">
        <span className="eyebrow">TODAY&apos;S MARKET OBSERVATION</span>
        <h2 id="market-observer-teaser-title">{data.homeObservation.conclusion}</h2>
        <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </div>
      <Link href={data.homeObservation.href}>查看证据链<ArrowRight size={14} /></Link>
    </section>
  );
}
