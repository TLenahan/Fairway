import { drillById } from '@golf/program';
import { z } from 'zod';

import { defineTool } from './tool';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

export const getRecaps = defineTool({
  name: 'get_recaps',
  title: 'Get coach recaps',
  description:
    'What the Reform Coach already told this golfer, newest-first: the ' +
    'headline, the prose, and the structured issues, strengths, drills and ' +
    'caveats it recorded per session. Read this before offering an opinion ' +
    'of your own — the coach has continuity across sessions that a single ' +
    'question does not, and contradicting last week\'s recap without knowing ' +
    'it exists is how a golfer ends up working on two things at once.',
  inputSchema: {
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(`newest N recaps; default ${DEFAULT_LIMIT}`),
    session_id: z.string().optional().describe('recaps for one session only'),
  },
  async run({ data }, args) {
    const limit = args.limit ?? DEFAULT_LIMIT;

    // Sessions come back newest-first. Only `limit` of them need their
    // analyses read: a session can hold more than one recap, but never enough
    // for an older session to displace a newer one's worth of them.
    const all = await data.listSessions();
    const sessions = args.session_id
      ? all.filter((s) => s.id === args.session_id)
      : all.slice(0, limit);

    const perSession = await Promise.all(
      sessions.map(async (session) => {
        const analyses = await data.listAnalyses(session.id);
        return analyses.map((analysis) => ({
          session_id: session.id,
          session_started_at_ms: session.startedAt,
          created_at_ms: analysis.createdAt,
          model: analysis.model,
          headline: analysis.verdict.headline,
          narrative: analysis.narrative,
          issues: analysis.verdict.issues,
          strengths: analysis.verdict.strengths,
          // The coach names drills by library id so its advice stays linked
          // to the re-measure loop; resolve to the human name here, where the
          // library is already loaded. An id the library no longer carries
          // keeps the id as its name rather than vanishing.
          drills: analysis.verdict.drills.map((drill) => ({
            ...drill,
            drill_id: drill.name,
            drill_name: drillById(drill.name)?.name ?? drill.name,
          })),
          caveats: analysis.verdict.caveats,
        }));
      }),
    );

    const recaps = perSession
      .flat()
      .sort((a, b) => b.created_at_ms - a.created_at_ms)
      .slice(0, limit);

    return { total: recaps.length, recaps };
  },
});
