import { classifyRep, toleranceFor } from './classify';

describe('toleranceFor', () => {
  it('scales at 8% of the anchor angle', () => {
    expect(toleranceFor(100)).toBeCloseTo(8);
    expect(toleranceFor(80)).toBeCloseTo(6.4);
  });

  it('floors at 4° for small anchors — and for no anchor at all', () => {
    expect(toleranceFor(10)).toBe(4); // 0.8° would be noise-chasing
    expect(toleranceFor(50)).toBe(4); // exactly on the floor
    expect(toleranceFor(0)).toBe(4); // the pre-anchor default
  });

  it('caps at 12° for huge anchors', () => {
    expect(toleranceFor(150)).toBe(12); // exactly on the cap
    expect(toleranceFor(200)).toBe(12);
  });
});

describe('classifyRep', () => {
  it('is calibrating whenever no target exists', () => {
    expect(classifyRep(60, null, 5)).toBe('calibrating');
    expect(classifyRep(0, null, 5)).toBe('calibrating');
  });

  it('judges over / under / match against the tolerance band', () => {
    expect(classifyRep(66, 60, 5)).toBe('over');
    expect(classifyRep(54, 60, 5)).toBe('under');
    expect(classifyRep(62, 60, 5)).toBe('match');
    expect(classifyRep(58, 60, 5)).toBe('match');
    expect(classifyRep(60, 60, 5)).toBe('match');
  });

  it('is boundary-inclusive: |delta| = tolerance still matches', () => {
    expect(classifyRep(65, 60, 5)).toBe('match');
    expect(classifyRep(55, 60, 5)).toBe('match');
    expect(classifyRep(65.001, 60, 5)).toBe('over');
    expect(classifyRep(54.999, 60, 5)).toBe('under');
  });
});
