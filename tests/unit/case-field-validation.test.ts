/**
 * Unit tests — pure Case Field validators (no DB).
 */
import { describe, it, expect } from '@jest/globals';
import { CaseFieldType, CaseFieldConditionOperator } from '@prisma/client';
import {
  isSelectType,
  validateValidationRules,
  validateVisibility,
  operatorAllowedForType,
  validateScalarConditionValue,
  assertNoOptionCycle,
} from '../../src/services/case-field.validation';
import { ValidationError } from '../../src/types/exceptions';

const T = CaseFieldType;
const O = CaseFieldConditionOperator;

describe('isSelectType', () => {
  it('is true only for SELECT and MULTI_SELECT', () => {
    expect(isSelectType(T.SELECT)).toBe(true);
    expect(isSelectType(T.MULTI_SELECT)).toBe(true);
    expect(isSelectType(T.TEXT)).toBe(false);
    expect(isSelectType(T.NUMBER)).toBe(false);
  });
});

describe('validateValidationRules', () => {
  it('accepts valid per-type keys', () => {
    expect(() => validateValidationRules(T.TEXT, { minLength: 1, maxLength: 5, pattern: '^a' })).not.toThrow();
    expect(() => validateValidationRules(T.NUMBER, { min: 0, max: 10 })).not.toThrow();
    expect(() => validateValidationRules(T.DATE, { minDate: '2026-01-01' })).not.toThrow();
    expect(() => validateValidationRules(T.MULTI_SELECT, { minSelections: 1, maxSelections: 3 })).not.toThrow();
    expect(() => validateValidationRules(T.BOOLEAN, {})).not.toThrow();
  });

  it('rejects unknown keys for the type', () => {
    expect(() => validateValidationRules(T.TEXT, { min: 1 })).toThrow(ValidationError);
    expect(() => validateValidationRules(T.NUMBER, { pattern: 'x' })).toThrow(ValidationError);
    expect(() => validateValidationRules(T.BOOLEAN, { minLength: 1 })).toThrow(ValidationError);
  });

  it('rejects wrong value types', () => {
    expect(() => validateValidationRules(T.TEXT, { minLength: '1' })).toThrow(ValidationError);
    expect(() => validateValidationRules(T.NUMBER, { min: 'x' })).toThrow(ValidationError);
  });

  it('rejects min > max', () => {
    expect(() => validateValidationRules(T.TEXT, { minLength: 5, maxLength: 1 })).toThrow(ValidationError);
    expect(() => validateValidationRules(T.NUMBER, { min: 5, max: 1 })).toThrow(ValidationError);
    expect(() => validateValidationRules(T.MULTI_SELECT, { minSelections: 3, maxSelections: 1 })).toThrow(ValidationError);
  });

  it('rejects a non-object', () => {
    expect(() => validateValidationRules(T.TEXT, [] as unknown)).toThrow(ValidationError);
  });
});

describe('validateVisibility', () => {
  it('accepts allowed shape', () => {
    expect(() => validateVisibility({ hidden: true, departmentIds: ['a'], roles: ['x'] })).not.toThrow();
    expect(() => validateVisibility({})).not.toThrow();
  });
  it('rejects unknown keys and wrong types', () => {
    expect(() => validateVisibility({ nope: 1 })).toThrow(ValidationError);
    expect(() => validateVisibility({ hidden: 'yes' })).toThrow(ValidationError);
    expect(() => validateVisibility({ departmentIds: [1, 2] })).toThrow(ValidationError);
  });
});

describe('operatorAllowedForType', () => {
  it('TEXT allows equality + presence, not comparison', () => {
    expect(operatorAllowedForType(T.TEXT, O.EQUALS)).toBe(true);
    expect(operatorAllowedForType(T.TEXT, O.IS_EMPTY)).toBe(true);
    expect(operatorAllowedForType(T.TEXT, O.GREATER_THAN)).toBe(false);
    expect(operatorAllowedForType(T.TEXT, O.IN)).toBe(false);
  });
  it('NUMBER / DATE allow comparison', () => {
    expect(operatorAllowedForType(T.NUMBER, O.GREATER_THAN)).toBe(true);
    expect(operatorAllowedForType(T.DATE, O.LESS_THAN)).toBe(true);
    expect(operatorAllowedForType(T.CURRENCY, O.GREATER_THAN)).toBe(true);
  });
  it('MULTI_SELECT allows IN/NOT_IN only (plus presence)', () => {
    expect(operatorAllowedForType(T.MULTI_SELECT, O.IN)).toBe(true);
    expect(operatorAllowedForType(T.MULTI_SELECT, O.EQUALS)).toBe(false);
  });
  it('SELECT / BOOLEAN allow equality + presence, not IN', () => {
    expect(operatorAllowedForType(T.SELECT, O.EQUALS)).toBe(true);
    expect(operatorAllowedForType(T.SELECT, O.IN)).toBe(false);
    expect(operatorAllowedForType(T.BOOLEAN, O.EQUALS)).toBe(true);
    expect(operatorAllowedForType(T.BOOLEAN, O.GREATER_THAN)).toBe(false);
  });
});

describe('validateScalarConditionValue', () => {
  it('accepts matching types', () => {
    expect(() => validateScalarConditionValue(T.NUMBER, 5)).not.toThrow();
    expect(() => validateScalarConditionValue(T.BOOLEAN, true)).not.toThrow();
    expect(() => validateScalarConditionValue(T.DATE, '2026-01-01')).not.toThrow();
    expect(() => validateScalarConditionValue(T.TIME, '09:30')).not.toThrow();
    expect(() => validateScalarConditionValue(T.TEXT, 'hi')).not.toThrow();
    expect(() => validateScalarConditionValue(T.USER_REFERENCE, '11111111-1111-1111-1111-111111111111')).not.toThrow();
  });
  it('rejects mismatched types', () => {
    expect(() => validateScalarConditionValue(T.NUMBER, '5')).toThrow(ValidationError);
    expect(() => validateScalarConditionValue(T.BOOLEAN, 'true')).toThrow(ValidationError);
    expect(() => validateScalarConditionValue(T.DATE, 'not-a-date')).toThrow(ValidationError);
    expect(() => validateScalarConditionValue(T.USER_REFERENCE, 'not-a-uuid')).toThrow(ValidationError);
  });
});

describe('assertNoOptionCycle', () => {
  it('allows a null parent', () => {
    expect(() => assertNoOptionCycle('a', null, new Map())).not.toThrow();
  });
  it('rejects self-parent', () => {
    expect(() => assertNoOptionCycle('a', 'a', new Map())).toThrow(ValidationError);
  });
  it('rejects a cycle', () => {
    // a -> b -> c ; pointing c's... actually pointing a's parent to c closes a->b->c->a
    const parents = new Map<string, string | null>([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
    ]);
    // Make 'a' point at 'c' → a->c->b->a cycle
    expect(() => assertNoOptionCycle('a', 'c', parents)).toThrow(ValidationError);
  });
  it('allows a valid non-cyclic parent', () => {
    const parents = new Map<string, string | null>([
      ['a', null],
      ['b', 'a'],
    ]);
    expect(() => assertNoOptionCycle('c', 'b', parents)).not.toThrow();
  });
});
