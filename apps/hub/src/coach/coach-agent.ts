import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { COACH_SYSTEM_PROMPT } from '@golf/coach';

/**
 * Reform Coach — Managed Agents provisioning + the per-session recap run.
 *
 * The agent is a persisted, versioned resource: created ONCE, its id stored
 * in ~/.fairway/coach.json, and referenced by every recap session. The
 * environment uses deny-by-default networking (no hosts, no package
 * managers) so the sandbox that reads the session payload has no egress —
 * the payload itself is derived numeric metrics only (BUILD_SPEC §8.3). A
 * memory store carries program continuity (prior recaps, focus arcs) across
 * days; the system prompt tells the coach to read and update it.
 */

export interface CoachResources {
  agentId: string;
  environmentId: string;
  memoryStoreId: string;
  /** provisioned prompt fingerprint — a change triggers agents.update */
  promptHash: string;
}

const hash = (text: string): string => {
  // djb2 — stability marker for the provisioned prompt, not cryptographic
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(16);
};

function readResources(configPath: string): CoachResources | null {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as CoachResources;
  } catch {
    return null;
  }
}

/** Create-once / update-on-prompt-change. Returns stored ids on the hot path. */
export async function ensureCoachResources(
  client: Anthropic,
  dataDir: string,
): Promise<CoachResources> {
  const configPath = join(dataDir, 'coach.json');
  const promptHash = hash(COACH_SYSTEM_PROMPT);
  const stored = readResources(configPath);
  if (stored && stored.promptHash === promptHash) return stored;

  if (stored) {
    // same agent, new prompt — update creates a new immutable version
    await client.beta.agents.update(stored.agentId, {
      system: COACH_SYSTEM_PROMPT,
    });
    const updated: CoachResources = { ...stored, promptHash };
    writeFileSync(configPath, JSON.stringify(updated, null, 2));
    return updated;
  }

  const environment = await client.beta.environments.create({
    name: `fairway-coach-${Date.now()}`,
    config: {
      type: 'cloud',
      networking: { type: 'limited' }, // deny-by-default: no egress
    },
  });
  const memoryStore = await client.beta.memoryStores.create({
    name: 'Reform Coach memory',
    description:
      'Swing-reform program history for one student: daily recap notes, ' +
      'the current focus and its cue, what worked, what to re-check.',
  });
  const agent = await client.beta.agents.create({
    name: 'Reform Coach',
    model: { id: 'claude-opus-5', effort: 'high' },
    system: COACH_SYSTEM_PROMPT,
    tools: [{ type: 'agent_toolset_20260401' }],
  });

  const created: CoachResources = {
    agentId: agent.id,
    environmentId: environment.id,
    memoryStoreId: memoryStore.id,
    promptHash,
  };
  writeFileSync(configPath, JSON.stringify(created, null, 2));
  return created;
}

/** One recap = one Managed Agents session seeded with the payload. */
export async function runCoachSession(
  client: Anthropic,
  resources: CoachResources,
  payloadJson: string,
  title: string,
): Promise<string> {
  const session = await client.beta.sessions.create({
    agent: resources.agentId,
    environment_id: resources.environmentId,
    title,
    resources: [
      {
        type: 'memory_store',
        memory_store_id: resources.memoryStoreId,
        access: 'read_write',
        instructions:
          'Program history: prior daily recaps and focus notes. Read before ' +
          'writing today’s recap; update it after.',
      },
    ],
    initial_events: [
      {
        type: 'user.message',
        content: [
          {
            type: 'text',
            text:
              'Today’s practice session (contract v3 JSON below). ' +
              'Write the recap.\n\n' +
              payloadJson,
          },
        ],
      },
    ],
  });

  const stream = await client.beta.sessions.events.stream(session.id);
  const parts: string[] = [];
  for await (const event of stream) {
    if (event.type === 'agent.message') {
      for (const block of event.content) {
        if (block.type === 'text') parts.push(block.text);
      }
    } else if (event.type === 'session.error') {
      throw new Error(`coach session error: ${JSON.stringify(event)}`);
    } else if (event.type === 'session.status_terminated') {
      break;
    } else if (
      event.type === 'session.status_idle' &&
      event.stop_reason.type !== 'requires_action'
    ) {
      break;
    }
  }
  return parts.join('\n');
}
