import { CalendarDays, ShieldCheck, Target } from "lucide-react";
import Link from "next/link";
import { targetLabel } from "@/lib/public-prediction-view";
import type { PublicPredictionHorizon } from "@/lib/public-prediction-view";
import PredictionStatusPanel from "./PredictionStatusPanel";

function dateText(value: string | null) {
  return value ? value.replaceAll("-", ".") : "—";
}

function ProbabilityCard({ horizon }: { horizon: PublicPredictionHorizon }) {
  return (
    <div className="prediction-probability-card">
      <div className="prediction-probability-number">
        <strong>{horizon.probability == null ? "—" : `${horizon.probability.toFixed(1)}%`}</strong>
        <span>{targetLabel(horizon.target)}</span>
      </div>
      <p className="prediction-card-approved"><ShieldCheck size={13} aria-hidden="true" />已通过发布门槛</p>
      <p className="prediction-card-claim">{horizon.claim}</p>
      <dl className="prediction-card-meta">
        <div><dt><CalendarDays size={12} aria-hidden="true" />数据截至 / 到期</dt><dd>{dateText(horizon.asOf)} / {dateText(horizon.dueDate)}</dd></div>
      </dl>
    </div>
  );
}

function ObservationCard({ horizon }: { horizon: PublicPredictionHorizon }) {
  const items = horizon.observationItems ?? [];
  return (
    <div className="prediction-observation-card">
      <p className="prediction-observation-note">证据分，不是概率</p>
      <p className="prediction-card-claim">{horizon.claim}</p>
      {items.length ? (
        <ol className="prediction-observation-list">
          {items.map((item) => (
            <li key={`${item.code ?? item.sector}-${item.rank}`}>
              <span>{String(item.rank).padStart(2, "0")}</span>
              <div><strong>{item.sector}</strong>{item.code ? <code>{item.code}</code> : null}<small>{item.signal}</small></div>
              <em>{item.score.toFixed(1)}<small>证据分</small></em>
            </li>
          ))}
        </ol>
      ) : null}
      <dl className="prediction-card-meta">
        <div><dt><CalendarDays size={12} aria-hidden="true" />数据截至 / 到期</dt><dd>{dateText(horizon.asOf)} / {dateText(horizon.dueDate)}</dd></div>
      </dl>
    </div>
  );
}

export default function PredictionHorizonCard({ horizon, marketId, modelAvailability }: { horizon: PublicPredictionHorizon; marketId: string; modelAvailability: "trained" | "not_trained" | "not_implemented" }) {
  const mode = horizon.publicationStatus === "published" && horizon.outputMode === "probability"
    ? "probability"
    : horizon.outputMode === "evidence_observation" || horizon.outputMode === "current_observation"
      ? "observation"
      : "status";
  return (
    <article className={`prediction-horizon-card mode-${mode} state-${horizon.publicationStatus}`}>
      <header className="prediction-horizon-header">
        <div>
          <span className="prediction-horizon-sessions">{horizon.label}</span>
          <h3>{targetLabel(horizon.target)}</h3>
        </div>
        <Link href={horizon.historyUrl} aria-label="查看历史记录"><Target size={15} aria-hidden="true" /></Link>
      </header>
      {mode === "probability" ? <ProbabilityCard horizon={horizon} />
        : mode === "observation" ? <ObservationCard horizon={horizon} />
          : <PredictionStatusPanel horizon={horizon} modelAvailability={modelAvailability} />}
      <footer className="prediction-horizon-footer">
        <span>截至 {dateText(horizon.asOf)}</span>
        {marketId !== "a-share" ? <span className="prediction-horizon-no-probability">不发布概率</span> : null}
      </footer>
    </article>
  );
}
