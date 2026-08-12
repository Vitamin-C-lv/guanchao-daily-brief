export function isGlobalBriefForEdition(
  globalBrief: { mainArticle?: { articleUrl?: string } } | null | undefined,
  editionDate: string,
): boolean {
  return globalBrief?.mainArticle?.articleUrl === `/articles/global-market-brief-${editionDate}/`;
}

export function isGlobalBriefCurrentOrNewer(
  globalBrief: { mainArticle?: { articleUrl?: string } } | null | undefined,
  editionDate: string,
): boolean {
  const match = globalBrief?.mainArticle?.articleUrl?.match(/^\/articles\/global-market-brief-(\d{4}-\d{2}-\d{2})\/$/);
  return typeof match?.[1] === "string" && match[1] >= editionDate;
}

export function shouldShowLegacyHomeNarrative({
  view,
  editionDate,
  globalBrief,
}: {
  view: string;
  editionDate: string;
  globalBrief: { mainArticle?: { articleUrl?: string } } | null | undefined;
}): boolean {
  return view !== "overview" || !isGlobalBriefForEdition(globalBrief, editionDate);
}
