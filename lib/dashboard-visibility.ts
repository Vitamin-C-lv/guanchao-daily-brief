export function isGlobalBriefForEdition(
  globalBrief: { mainArticle?: { articleUrl?: string } } | null | undefined,
  editionDate: string,
): boolean {
  return globalBrief?.mainArticle?.articleUrl === `/articles/global-market-brief-${editionDate}/`;
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
