import type { ReviewFinding } from '../../src/review/schemas.js';

// Synthetic example used only in tests, never attributed to a real PR.
export const finding: ReviewFinding = {
  id: 'mock-1', severity: 'medium', category: 'correctness', title: 'Guard the missing user',
  file: 'src/user.ts', line: 12, description: 'The mock lookup can return undefined before user.name is accessed.',
  impact: 'An unknown user causes the request to throw.', evidence: 'The synthetic fixture dereferences user.name without a guard.',
  suggestion: 'Handle an absent user before reading its name.', confidence: 0.9,
};
