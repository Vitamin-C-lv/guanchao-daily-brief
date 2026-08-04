export default function TermExplainer({ term, plain }: { term: string; plain: string }) {
  return (
    <aside className="article-term" aria-label={`术语解释：${term}`}>
      <strong>{term}</strong>
      <span>{plain}</span>
    </aside>
  );
}
