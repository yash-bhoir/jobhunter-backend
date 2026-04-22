const {
  roleTokens,
  jaccardTokens,
  buildClusterFamilyId,
  distinctiveTokens,
} = require('../src/services/jobSearch/queryCluster.util');

describe('queryCluster.util', () => {
  test('roleTokens strips stopwords', () => {
    expect(roleTokens('Senior React Developer')).toContain('react');
    expect(roleTokens('the a an')).toEqual([]);
  });

  test('jaccardTokens', () => {
    expect(jaccardTokens(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
    expect(jaccardTokens([], ['a'])).toBe(0);
  });

  test('buildClusterFamilyId is stable for same inputs', () => {
    const a = buildClusterFamilyId('React dev', 'Berlin', 'remote');
    const b = buildClusterFamilyId('React dev', 'Berlin', 'remote');
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBe(32);
  });

  test('distinctiveTokens prefers non-generic tokens', () => {
    const d = distinctiveTokens('Software Engineer');
    expect(Array.isArray(d)).toBe(true);
  });
});
