const { computeBackoffDelaySeconds } = require('../src/scheduler');

describe('computeBackoffDelaySeconds', () => {
  test('base^0 = 1 second on first retry', () => {
    expect(computeBackoffDelaySeconds(2, 0)).toBe(1);
  });

  test('base^1 = base seconds', () => {
    expect(computeBackoffDelaySeconds(2, 1)).toBe(2);
  });

  test('base^3 = 8 seconds for base 2', () => {
    expect(computeBackoffDelaySeconds(2, 3)).toBe(8);
  });

  test('works with a different base', () => {
    expect(computeBackoffDelaySeconds(3, 2)).toBe(9);
  });
});