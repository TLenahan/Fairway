import { listClubs } from './clubs';
import { getBaseline, getBucketStatus, getFindings } from './insights';
import { getTrainingBlocks } from './program';
import { getRecaps } from './recaps';
import { listSessions } from './sessions';
import { queryShots } from './shots';
import { FairwayTool, ToolContext } from './tool';

/**
 * Every tool the MCP server publishes, in the order a caller would discover
 * them: what clubs exist → what sessions happened → what shots they hold →
 * what the engine concluded → what is being worked on → what the coach said.
 * Clients list tools in this order, and a model reads that list top to
 * bottom, so the ordering is documentation.
 */
export const TOOLS: readonly FairwayTool[] = [
  listClubs,
  listSessions,
  queryShots,
  getBucketStatus,
  getBaseline,
  getFindings,
  getTrainingBlocks,
  getRecaps,
];

export function toolByName(name: string): FairwayTool | null {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

/**
 * Dispatch by name. Throws on an unknown tool rather than returning an empty
 * result: a client asking for a tool that does not exist has a stale tool
 * list, and an empty answer would read as "no data" instead of "wrong call".
 */
export async function callTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const tool = toolByName(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.run(ctx, args);
}

/**
 * Server-level guidance, published as MCP instructions. It carries the two
 * things a model cannot infer from the tool list alone: that this data is one
 * specific golfer's, judged against their own baselines rather than any
 * external standard, and that the numbers here are already guardrailed — so
 * the honest move is to report them, not to re-derive or hedge them.
 */
export const SERVER_INSTRUCTIONS = [
  "This server exposes one golfer's own launch-monitor and wrist-sensor",
  'practice history from the Fairway hub, plus the analytics engine run over',
  'it. It is read-only.',
  '',
  'Three things to hold on to:',
  '',
  '1. Every standard here is the golfer\'s own. "Great" means great for them,',
  '   measured against their own best shots with that club — never a tour',
  '   average or a universal target. Do not import outside benchmarks.',
  '2. Statistics key on (club, intent) buckets. A club has a separate',
  '   baseline for stock, draw and fade shots; `untagged` is a quarantine',
  '   bucket that no statistic counts. Warmup and discarded shots are',
  '   excluded everywhere.',
  '3. The engine is already conservative. Findings that survive to',
  '   get_findings cleared a cross-session persistence gate and an effect-size',
  '   gate; an uncertified bucket means "not enough evidence yet", not',
  '   "something is wrong". Report what the tools return rather than',
  '   recomputing it or softening it into nothing.',
  '',
  'Units are SI throughout: metres, m/s, degrees, rpm. Convert when you',
  'present them.',
].join('\n');
