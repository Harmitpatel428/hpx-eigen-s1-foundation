/**
 * Unit tests — pure Case Field VALUE validators / rule evaluation (no DB).
 */
import { describe, it, expect } from '@jest/globals';
import { CaseFieldType, CaseFieldConditionOperator } from '@prisma/client';
import {
  coerceValue, conditionMet, isPresent, StoredValue,
} from '../../src/services/case-field-value.validation';
import { ValidationError } from '../../src/types/exceptions';

const T = CaseFieldType;
const O = CaseFieldConditionOperator;
const f = (type: CaseFieldType, validationRules: unknown = {}) => ({ type, validationRules });

describe('coerceValue — typed coercion + validationRules', () => {
  it('TEXT with length + pattern rules', () => {
    expect(coerceValue(f(T.TEXT, { minLength: 2, maxLength: 5, pattern: '^[a-z]+$' }), { value: 'abc' }))
      .toEqual({ isClear: false, valueText: 'abc' });
    expect(() => coerceValue(f(T.TEXT, { minLength: 2 }), { value: 'a' })).toThrow(ValidationError);
    expect(() => coerceValue(f(T.TEXT, { maxLength: 2 }), { value: 'abcd' })).toThrow(ValidationError);
    expect(() => coerceValue(f(T.TEXT, { pattern: '^[a-z]+$' }), { value: 'AB1' })).toThrow(ValidationError);
    expect(() => coerceValue(f(T.TEXT), { value: 5 })).toThrow(ValidationError);
  });
  it('NUMBER with min/max', () => {
    expect(coerceValue(f(T.NUMBER, { min: 0, max: 10 }), { value: 7 })).toEqual({ isClear: false, valueNumber: 7 });
    expect(() => coerceValue(f(T.NUMBER, { min: 0 }), { value: -1 })).toThrow(ValidationError);
    expect(() => coerceValue(f(T.CURRENCY), { value: 'x' })).toThrow(ValidationError);
  });
  it('BOOLEAN', () => {
    expect(coerceValue(f(T.BOOLEAN), { value: true })).toEqual({ isClear: false, valueBoolean: true });
    expect(() => coerceValue(f(T.BOOLEAN), { value: 'true' })).toThrow(ValidationError);
  });
  it('DATE with min/max', () => {
    const r = coerceValue(f(T.DATE, { minDate: '2026-01-01', maxDate: '2026-12-31' }), { value: '2026-06-01' });
    expect(r.isClear).toBe(false);
    expect(r.valueDate instanceof Date).toBe(true);
    expect(() => coerceValue(f(T.DATE, { minDate: '2026-01-01' }), { value: '2025-01-01' })).toThrow(ValidationError);
    expect(() => coerceValue(f(T.DATE), { value: 'nope' })).toThrow(ValidationError);
  });
  it('SELECT → optionId', () => {
    expect(coerceValue(f(T.SELECT), { optionId: 'opt1' })).toEqual({ isClear: false, optionId: 'opt1' });
    expect(coerceValue(f(T.SELECT), { optionId: null })).toEqual({ isClear: true, optionId: null });
  });
  it('MULTI_SELECT → optionIds with min/max + dedupe', () => {
    expect(coerceValue(f(T.MULTI_SELECT), { optionIds: ['a', 'b', 'a'] })).toEqual({ isClear: false, optionIds: ['a', 'b'] });
    expect(() => coerceValue(f(T.MULTI_SELECT, { minSelections: 2 }), { optionIds: ['a'] })).toThrow(ValidationError);
    expect(() => coerceValue(f(T.MULTI_SELECT, { maxSelections: 1 }), { optionIds: ['a', 'b'] })).toThrow(ValidationError);
    expect(coerceValue(f(T.MULTI_SELECT), { optionIds: [] })).toEqual({ isClear: true, optionIds: [] });
  });
  it('clear when value absent/empty', () => {
    expect(coerceValue(f(T.TEXT), {}).isClear).toBe(true);
    expect(coerceValue(f(T.NUMBER), { value: null }).isClear).toBe(true);
  });
});

const stored = (over: Partial<StoredValue>): StoredValue => ({
  fieldType: T.TEXT, valueText: null, valueNumber: null, valueBoolean: null,
  valueDate: null, optionId: null, optionIds: [], ...over,
});

describe('isPresent', () => {
  it('detects presence per type', () => {
    expect(isPresent(undefined)).toBe(false);
    expect(isPresent(stored({ valueText: 'x' }))).toBe(true);
    expect(isPresent(stored({ fieldType: T.SELECT, optionId: 'o' }))).toBe(true);
    expect(isPresent(stored({ fieldType: T.SELECT }))).toBe(false);
    expect(isPresent(stored({ fieldType: T.MULTI_SELECT, optionIds: ['a'] }))).toBe(true);
    expect(isPresent(stored({ fieldType: T.MULTI_SELECT, optionIds: [] }))).toBe(false);
  });
});

describe('conditionMet — rule applicability', () => {
  it('IS_NOT_EMPTY / IS_EMPTY', () => {
    expect(conditionMet(O.IS_NOT_EMPTY, null, null, stored({ valueText: 'x' }))).toBe(true);
    expect(conditionMet(O.IS_NOT_EMPTY, null, null, undefined)).toBe(false);
    expect(conditionMet(O.IS_EMPTY, null, null, undefined)).toBe(true);
  });
  it('SELECT EQUALS matches optionId', () => {
    const s = stored({ fieldType: T.SELECT, optionId: 'opt1' });
    expect(conditionMet(O.EQUALS, null, 'opt1', s)).toBe(true);
    expect(conditionMet(O.EQUALS, null, 'opt2', s)).toBe(false);
    expect(conditionMet(O.NOT_EQUALS, null, 'opt2', s)).toBe(true);
  });
  it('MULTI_SELECT IN / NOT_IN', () => {
    const s = stored({ fieldType: T.MULTI_SELECT, optionIds: ['a', 'b'] });
    expect(conditionMet(O.IN, ['b', 'z'], null, s)).toBe(true);
    expect(conditionMet(O.IN, ['z'], null, s)).toBe(false);
    expect(conditionMet(O.NOT_IN, ['z'], null, s)).toBe(true);
  });
  it('numeric GREATER_THAN / LESS_THAN / EQUALS', () => {
    const s = stored({ fieldType: T.NUMBER, valueNumber: 10 });
    expect(conditionMet(O.GREATER_THAN, 5, null, s)).toBe(true);
    expect(conditionMet(O.LESS_THAN, 5, null, s)).toBe(false);
    expect(conditionMet(O.EQUALS, 10, null, s)).toBe(true);
  });
  it('no stored value → equality/comparison false', () => {
    expect(conditionMet(O.EQUALS, 10, null, undefined)).toBe(false);
    expect(conditionMet(O.GREATER_THAN, 5, null, stored({ fieldType: T.NUMBER }))).toBe(false);
  });
});
