import { describe, expect, it } from 'vitest';

import { sanitizeNote, validateVisitDate } from './validation';

describe('validateVisitDate', () => {
  it.each([
    ['2024', 'year'],
    ['2024-07', 'month'],
    ['2024-02-29', 'day'],
  ] as const)('accepts %s with %s precision', (value, precision) => {
    expect(validateVisitDate(value)).toEqual({ value, precision });
  });

  it.each(['', '24', '2024-13', '2023-02-29', '2024-04-31'])('rejects invalid value %s', (value) => {
    expect(() => validateVisitDate(value)).toThrow('日期无效');
  });
});

describe('sanitizeNote', () => {
  it('trims a plain-text note', () => {
    expect(sanitizeNote('  海边散步  ')).toBe('海边散步');
  });

  it('counts Unicode code points and rejects more than 500', () => {
    expect(sanitizeNote('🌍'.repeat(500))).toHaveLength(1000);
    expect(() => sanitizeNote('🌍'.repeat(501))).toThrow('备注不能超过 500 个字符');
  });
});
