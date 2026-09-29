/**
 * Unit tests — Phase 5 pure functions: rule runtime, cycle detection, default payload.
 */
import { describe, it, expect } from '@jest/globals';
import { CaseFieldType, CaseFieldConditionOperator, CaseFieldRuleEffectType } from '@prisma/client';
import { computeFieldRuntime, RuntimeRule, StoredValue } from '../../src/services/case-field-value.validation';
import { assertNoRuleCycle, validateDefaultPayload } from '../../src/services/case-field.validation';
import { ValidationError, BusinessRuleViolationError } from '../../src/types/exceptions';

const T = CaseFieldType;
const O = CaseFieldConditionOperator;
const E = CaseFieldRuleEffectType;

const stored = (over: Partial<StoredValue>): StoredValue => ({
  fieldType: T.TEXT, valueText: null, valueNumber: null, valueBoolean: null, valueDate: null, optionId: null, optionIds: [], ...over,
});
const rule = (o: Partial<RuntimeRule>): RuntimeRule => ({
  priority: 0, createdAt: new Date('2026-01-01'), effectType: E.REQUIRE_FIELD,
  conditionFieldId: 'c', conditionOperator: O.IS_NOT_EMPTY, conditionValue: null, conditionOptionId: null,
  targetFieldId: 't', defaultPayload: null, ...o,
});

describe('computeFieldRuntime', () => {
  const ids = new Set(['c', 't']);
  const condSet = new Map<string, StoredValue>([['c', stored({ valueText: 'x' })]]);

  it('REQUIRE fires when condition met and target empty', () => {
    const rt = computeFieldRuntime(ids, new Set(), condSet, [rule({})]);
    expect(rt.get('t')!.isRequired).toBe(true);
    expect(rt.get('t')!.isHidden).toBe(false);
  });

  it('HIDE_FIELD wins: hidden target suspends REQUIRE and SET_DEFAULT', () => {
    const rules = [
      rule({ effectType: E.HIDE_FIELD }),
      rule({ effectType: E.REQUIRE_FIELD }),
      rule({ effectType: E.SET_DEFAULT, defaultPayload: { value: 'd' } }),
    ];
    const rt = computeFieldRuntime(ids, new Set(), condSet, rules).get('t')!;
    expect(rt.isHidden).toBe(true);
    expect(rt.isRequired).toBe(false);
    expect(rt.defaultPayload).toBeNull();
  });

  it('static visibility.hidden marks hidden', () => {
    const rt = computeFieldRuntime(ids, new Set(['t']), condSet, []);
    expect(rt.get('t')!.isHidden).toBe(true);
  });

  it('SET_DEFAULT only when no stored value; last-in-order (priority) wins', () => {
    const noValue = new Map<string, StoredValue>([['c', stored({ valueText: 'x' })]]);
    const rules = [
      rule({ effectType: E.SET_DEFAULT, priority: 1, defaultPayload: { value: 'low' } }),
      rule({ effectType: E.SET_DEFAULT, priority: 5, defaultPayload: { value: 'high' } }),
    ];
    expect(computeFieldRuntime(ids, new Set(), noValue, rules).get('t')!.defaultPayload).toEqual({ value: 'high' });

    const withValue = new Map<string, StoredValue>([['c', stored({ valueText: 'x' })], ['t', stored({ valueText: 'set' })]]);
    expect(computeFieldRuntime(ids, new Set(), withValue, rules).get('t')!.defaultPayload).toBeNull();
  });

  it('HIDE rule ignored when its condition field is itself hidden', () => {
    // c hidden statically; a HIDE rule keyed on c should not fire.
    const rt = computeFieldRuntime(ids, new Set(['c']), condSet, [rule({ effectType: E.HIDE_FIELD })]);
    expect(rt.get('t')!.isHidden).toBe(false);
  });
});

describe('assertNoRuleCycle', () => {
  it('allows an acyclic edge', () => {
    expect(() => assertNoRuleCycle([{ from: 'a', to: 'b' }], { from: 'b', to: 'c' })).not.toThrow();
  });
  it('rejects a 2-cycle (A->B exists, add B->A)', () => {
    expect(() => assertNoRuleCycle([{ from: 'a', to: 'b' }], { from: 'b', to: 'a' })).toThrow(BusinessRuleViolationError);
  });
  it('rejects a longer cycle (A->B->C, add C->A)', () => {
    expect(() => assertNoRuleCycle([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], { from: 'c', to: 'a' })).toThrow(BusinessRuleViolationError);
  });
});

describe('validateDefaultPayload', () => {
  it('SELECT requires optionId', () => {
    expect(() => validateDefaultPayload(T.SELECT, { optionId: 'o1' })).not.toThrow();
    expect(() => validateDefaultPayload(T.SELECT, { value: 'x' })).toThrow(ValidationError);
  });
  it('MULTI_SELECT requires non-empty optionIds', () => {
    expect(() => validateDefaultPayload(T.MULTI_SELECT, { optionIds: ['a'] })).not.toThrow();
    expect(() => validateDefaultPayload(T.MULTI_SELECT, { optionIds: [] })).toThrow(ValidationError);
  });
  it('non-option needs {value} of correct primitive', () => {
    expect(() => validateDefaultPayload(T.NUMBER, { value: 3 })).not.toThrow();
    expect(() => validateDefaultPayload(T.NUMBER, { value: 'x' })).toThrow(ValidationError);
    expect(() => validateDefaultPayload(T.TEXT, {})).toThrow(ValidationError);
  });
  it('rejects a non-object payload', () => {
    expect(() => validateDefaultPayload(T.TEXT, null)).toThrow(ValidationError);
  });
});
