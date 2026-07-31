import { resolveBlockWire } from '@golf/program';
import { TrainingBlockStatusSchema } from '@golf/types';
import { z } from 'zod';

import { defineTool } from './tool';

export const getTrainingBlocks = defineTool({
  name: 'get_training_blocks',
  title: 'Get training blocks',
  description:
    'Drill work in flight and its history: what was prescribed against which ' +
    'finding, the drill protocol, the tolerance band it is judged against, ' +
    'and how it resolved. Statuses are active (re-measure window still ' +
    'open), graduated (target metric moved AND the linked outcome improved), ' +
    'escalated (window closed without both — needs a different approach), ' +
    'abandoned (dismissed). Check this before proposing a drill: a finding ' +
    'with an active block is already being worked, and re-prescribing it in ' +
    'prose just competes with the loop.',
  inputSchema: {
    status: TrainingBlockStatusSchema.optional().describe(
      'active | graduated | escalated | abandoned; omit for all',
    ),
    club_id: z.string().optional(),
  },
  async run({ data }, args) {
    // NOTE: read-only on purpose. Prescribing and judging blocks is the hub's
    // job (program-runner.ts), driven by real shots arriving — not something
    // a model should be able to trigger by asking what it is working on.
    const blocks = await data.listTrainingBlocks(
      args.status ? { status: args.status } : undefined,
    );

    const filtered = blocks.filter(
      (block) => args.club_id === undefined || block.clubId === args.club_id,
    );

    return {
      total: filtered.length,
      blocks: filtered.map(resolveBlockWire),
    };
  },
});
