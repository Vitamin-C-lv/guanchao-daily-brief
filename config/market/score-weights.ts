export const MARKET_OBSERVER_SCORE_WEIGHTS = {
  etfFlow: 0.3,
  relativeMomentum: 0.2,
  breadth: 0.15,
  institution: 0.15,
  macroFit: 0.1,
  policyLink: 0.1,
  crowdingPenalty: 0.15,
} as const;

export const MINIMUM_AVAILABLE_POSITIVE_FACTORS = 3;
