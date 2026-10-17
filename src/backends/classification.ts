import type { Route } from '../contracts/backend.ts';

export function parseClassification(text: string, threshold = 0.9): Route {
  try { const value = JSON.parse(text.trim()); return ['shell', 'agent'].includes(value.route) && typeof value.confidence === 'number' && value.confidence >= threshold && value.confidence <= 1 ? value.route : 'ask'; }
  catch { return 'ask'; }
}
