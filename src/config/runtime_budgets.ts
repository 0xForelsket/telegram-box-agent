export const RUNTIME_BUDGETS = Object.freeze({
  maxToolRounds: 3,
  maxSearchAttempts: 3,
  maxSources: 8,
  maxPagesRead: 2,
  maxPageBytes: 500_000,
  maxConcurrentOutboundRequests: 3,
});

export type RuntimeBudgets = typeof RUNTIME_BUDGETS;
