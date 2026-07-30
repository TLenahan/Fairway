import { allDrills } from '@golf/program';

import { COACH_DRILL_IDS, COACH_SYSTEM_PROMPT } from './prompt';

describe('COACH_DRILL_IDS', () => {
  it('matches the drill library ids exactly (§6.12 rule 1: one library)', () => {
    const libraryIds = allDrills().map((drill) => drill.id);
    expect(COACH_DRILL_IDS).toEqual(libraryIds);
  });
});

describe('COACH_SYSTEM_PROMPT', () => {
  it('mentions every library drill id, so a new drill can never go unlisted', () => {
    for (const drill of allDrills()) {
      expect(COACH_SYSTEM_PROMPT).toContain(drill.id);
    }
  });

  it('mentions every library drill name and summary, not just the id', () => {
    for (const drill of allDrills()) {
      expect(COACH_SYSTEM_PROMPT).toContain(drill.name);
      expect(COACH_SYSTEM_PROMPT).toContain(drill.summary);
    }
  });

  it('still states the never-invent rule', () => {
    expect(COACH_SYSTEM_PROMPT).toContain('never invent a drill');
  });

  it('states that an active block is reinforced, not re-prescribed', () => {
    expect(COACH_SYSTEM_PROMPT.toLowerCase()).toContain('active training block');
  });

  it('restates that a bias entry never earns a drill', () => {
    expect(COACH_SYSTEM_PROMPT).toContain('a `bias` entry never earns a drill');
  });
});
