import { AnalysisVerdict, AnalysisVerdictSchema } from '@golf/types';

/**
 * Parse the coach's reply: prose narrative followed by one fenced json block
 * carrying the AnalysisVerdict (the same shape the in-app analysis uses, so
 * recaps persist to the existing analyses table and render anywhere a
 * verdict already renders).
 */
export interface CoachRecap {
  narrative: string;
  verdict: AnalysisVerdict | null;
}

const FENCE = /```json\s*([\s\S]*?)```/g;

export function parseCoachRecap(text: string): CoachRecap {
  const matches = [...text.matchAll(FENCE)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) {
    return { narrative: text.trim(), verdict: null };
  }

  const narrative = (
    text.slice(0, last.index) + text.slice(last.index + last[0].length)
  ).trim();
  try {
    const verdict = AnalysisVerdictSchema.parse(JSON.parse(last[1]));
    return { narrative, verdict };
  } catch {
    return { narrative: text.trim(), verdict: null };
  }
}
