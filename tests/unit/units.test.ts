import { describe, expect, it } from 'vitest';
import {
  convertLength,
  defaultInputUnit,
  formatArea,
  formatFeetInches,
  formatLength,
  fromMillimetres,
  mm2ToFt2,
  mm2ToM2,
  parseLengthToMm,
  toMillimetres,
} from '@/domain/units';

describe('unit conversion', () => {
  it('converts every supported unit to millimetres exactly', () => {
    expect(toMillimetres(1, 'mm')).toBe(1);
    expect(toMillimetres(1, 'cm')).toBe(10);
    expect(toMillimetres(1, 'm')).toBe(1000);
    expect(toMillimetres(1, 'in')).toBeCloseTo(25.4, 10);
    expect(toMillimetres(1, 'ft')).toBeCloseTo(304.8, 10);
  });

  it('round-trips without drift', () => {
    for (const unit of ['mm', 'cm', 'm', 'in', 'ft'] as const) {
      for (const value of [0.5, 1, 2.7, 123.456, 10_000]) {
        expect(fromMillimetres(toMillimetres(value, unit), unit)).toBeCloseTo(value, 9);
      }
    }
  });

  it('converts between arbitrary pairs', () => {
    expect(convertLength(1, 'm', 'mm')).toBe(1000);
    expect(convertLength(12, 'in', 'ft')).toBeCloseTo(1, 10);
    expect(convertLength(2.4, 'm', 'ft')).toBeCloseTo(7.874, 3);
  });

  it('converts areas', () => {
    expect(mm2ToM2(1_000_000)).toBe(1);
    expect(mm2ToFt2(304.8 * 304.8)).toBeCloseTo(1, 9);
  });
});

describe('formatLength', () => {
  it('uses millimetres below a metre and metres above', () => {
    expect(formatLength(850, 'metric')).toBe('850 mm');
    expect(formatLength(2700, 'metric')).toBe('2.7 m');
    expect(formatLength(12_000, 'metric')).toBe('12 m');
  });

  it('handles negatives and non-finite values', () => {
    expect(formatLength(-450, 'metric')).toBe('-450 mm');
    expect(formatLength(Number.NaN, 'metric')).toBe('—');
    expect(formatLength(Number.POSITIVE_INFINITY, 'metric')).toBe('—');
  });

  it('renders imperial as feet and inches to the nearest sixteenth', () => {
    expect(formatFeetInches(304.8)).toBe("1'");
    expect(formatFeetInches(304.8 + 25.4 * 6)).toBe(`1' 6"`);
    expect(formatFeetInches(25.4)).toBe('1"');
    // 3 m is 118.110" = 9 ft 10.110", which rounds to the nearest 1/16 as 1/8.
    expect(formatFeetInches(3000)).toBe(`9' 10 1/8"`);
  });

  it('respects a forced unit', () => {
    expect(formatLength(2700, 'metric', { forceUnit: 'mm' })).toBe('2700 mm');
    expect(formatLength(2700, 'metric', { forceUnit: 'm', precision: 1 })).toBe('2.7 m');
  });

  it('formats areas in both systems', () => {
    expect(formatArea(96_000_000, 'metric')).toBe('96 m²');
    expect(formatArea(96_000_000, 'imperial')).toContain('sq ft');
  });
});

describe('parseLengthToMm', () => {
  it('reads bare numbers in the default unit', () => {
    expect(parseLengthToMm('12', 'm')).toBe(12_000);
    expect(parseLengthToMm('12', 'mm')).toBe(12);
    expect(parseLengthToMm('8', 'ft')).toBeCloseTo(2438.4, 6);
  });

  it('reads explicit units', () => {
    expect(parseLengthToMm('2400mm')).toBe(2400);
    expect(parseLengthToMm('2.4m')).toBe(2400);
    expect(parseLengthToMm('240 cm')).toBe(2400);
    expect(parseLengthToMm('96in')).toBeCloseTo(2438.4, 6);
    expect(parseLengthToMm('8ft')).toBeCloseTo(2438.4, 6);
  });

  it('reads feet-and-inches notation', () => {
    expect(parseLengthToMm(`8'`)).toBeCloseTo(2438.4, 6);
    expect(parseLengthToMm(`8' 6"`)).toBeCloseTo(2590.8, 6);
    expect(parseLengthToMm(`8'6`)).toBeCloseTo(2590.8, 6);
  });

  it('accepts a comma decimal separator', () => {
    expect(parseLengthToMm('2,4 m')).toBe(2400);
  });

  it('returns null for anything that is not a dimension', () => {
    expect(parseLengthToMm('')).toBeNull();
    expect(parseLengthToMm('wide')).toBeNull();
    expect(parseLengthToMm('12 bananas')).toBeNull();
    expect(parseLengthToMm('--3m')).toBeNull();
  });

  it('picks a sensible default unit from the display system', () => {
    expect(defaultInputUnit('metric')).toBe('m');
    expect(defaultInputUnit('imperial')).toBe('ft');
  });
});
