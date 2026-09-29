import { CaseFieldType, CaseFieldConditionOperator } from '@prisma/client';
import { ValidationError } from '../types/exceptions';

const NUMERIC = new Set<CaseFieldType>([
  CaseFieldType.NUMBER, CaseFieldType.DECIMAL, CaseFieldType.CURRENCY, CaseFieldType.PERCENTAGE,
]);
const DATEISH = new Set<CaseFieldType>([CaseFieldType.DATE, CaseFieldType.DATETIME]);
const STRINGLIKE = new Set<CaseFieldType>([
  CaseFieldType.TEXT, CaseFieldType.TEXTAREA, CaseFieldType.EMAIL, CaseFieldType.PHONE,
  CaseFieldType.URL, CaseFieldType.TIME,
  CaseFieldType.USER_REFERENCE, CaseFieldType.DEPARTMENT_REFERENCE,
  CaseFieldType.CASE_REFERENCE, CaseFieldType.DOCUMENT_REFERENCE,
]);

/** Which storage column(s) a field type uses. */
export function isMultiSelect(t: CaseFieldType): boolean { return t === CaseFieldType.MULTI_SELECT; }
export function isSingleSelect(t: CaseFieldType): boolean { return t === CaseFieldType.SELECT; }

/** Coerced storage form: exactly one of the value fields is set (or isClear). */
export interface TypedValue {
  isClear: boolean;
  valueText?: string | null;
  valueNumber?: number | null;
  valueBoolean?: boolean | null;
  valueDate?: Date | null;
  optionId?: string | null;     // SELECT
  optionIds?: string[];         // MULTI_SELECT
}

interface RawEntry { value?: unknown; optionId?: unknown; optionIds?: unknown }

function rules(field: { validationRules: unknown }): Record<string, unknown> {
  const r = field.validationRules;
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
}

/**
 * Validate & coerce a raw PATCH entry against a field's type + validationRules.
 * Returns the typed storage form. A null/absent value is a clear.
 * Throws ValidationError (400) on any type/shape/constraint violation.
 * Option membership is NOT checked here (needs DB) — the service does that.
 */
export function coerceValue(
  field: { type: CaseFieldType; validationRules: unknown },
  entry: RawEntry,
): TypedValue {
  const t = field.type;
  const vr = rules(field);

  if (isSingleSelect(t)) {
    const opt = entry.optionId;
    if (opt === null || opt === undefined || opt === '') return { isClear: true, optionId: null };
    if (typeof opt !== 'string') throw new ValidationError('optionId must be a string for a SELECT field.');
    return { isClear: false, optionId: opt };
  }
  if (isMultiSelect(t)) {
    const ids = entry.optionIds;
    if (ids === null || ids === undefined || (Array.isArray(ids) && ids.length === 0)) return { isClear: true, optionIds: [] };
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
      throw new ValidationError('optionIds must be an array of strings for a MULTI_SELECT field.');
    }
    const uniq = [...new Set(ids as string[])];
    if (typeof vr.minSelections === 'number' && uniq.length < vr.minSelections) {
      throw new ValidationError(`At least ${vr.minSelections} selection(s) required.`);
    }
    if (typeof vr.maxSelections === 'number' && uniq.length > vr.maxSelections) {
      throw new ValidationError(`At most ${vr.maxSelections} selection(s) allowed.`);
    }
    return { isClear: false, optionIds: uniq };
  }

  const raw = entry.value;
  if (raw === null || raw === undefined || raw === '') return { isClear: true };

  if (NUMERIC.has(t)) {
    if (typeof raw !== 'number' || Number.isNaN(raw)) throw new ValidationError('value must be a number.');
    if (typeof vr.min === 'number' && raw < vr.min) throw new ValidationError(`value must be >= ${vr.min}.`);
    if (typeof vr.max === 'number' && raw > vr.max) throw new ValidationError(`value must be <= ${vr.max}.`);
    return { isClear: false, valueNumber: raw };
  }
  if (t === CaseFieldType.BOOLEAN) {
    if (typeof raw !== 'boolean') throw new ValidationError('value must be a boolean.');
    return { isClear: false, valueBoolean: raw };
  }
  if (DATEISH.has(t)) {
    if (typeof raw !== 'string') throw new ValidationError('value must be an ISO date string.');
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new ValidationError('value must be a valid ISO date.');
    if (typeof vr.minDate === 'string' && d < new Date(vr.minDate)) throw new ValidationError(`value must be on/after ${vr.minDate}.`);
    if (typeof vr.maxDate === 'string' && d > new Date(vr.maxDate)) throw new ValidationError(`value must be on/before ${vr.maxDate}.`);
    return { isClear: false, valueDate: d };
  }
  if (STRINGLIKE.has(t)) {
    if (typeof raw !== 'string') throw new ValidationError('value must be a string.');
    if (typeof vr.minLength === 'number' && raw.length < vr.minLength) throw new ValidationError(`value must be at least ${vr.minLength} characters.`);
    if (typeof vr.maxLength === 'number' && raw.length > vr.maxLength) throw new ValidationError(`value must be at most ${vr.maxLength} characters.`);
    if (typeof vr.pattern === 'string' && !new RegExp(vr.pattern).test(raw)) throw new ValidationError('value does not match the required pattern.');
    return { isClear: false, valueText: raw };
  }
  throw new ValidationError(`Unsupported field type: ${t}.`);
}

/** Stored value row (subset) used for presence + condition checks. */
export interface StoredValue {
  fieldType: CaseFieldType;
  valueText: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
  valueDate: Date | null;
  optionId: string | null;
  optionIds: string[];
}

/** A value counts as "present" (non-empty) for REQUIRE_FIELD purposes. */
export function isPresent(v: StoredValue | undefined | null): boolean {
  if (!v) return false;
  if (isMultiSelect(v.fieldType)) return v.optionIds.length > 0;
  if (isSingleSelect(v.fieldType)) return v.optionId != null;
  return v.valueText != null || v.valueNumber != null || v.valueBoolean != null || v.valueDate != null;
}

/**
 * Evaluate a rule condition against the stored value of the CONDITION field.
 * Returns true when the condition is satisfied (i.e. the rule "fires").
 */
export function conditionMet(
  operator: CaseFieldConditionOperator,
  conditionValue: unknown,
  conditionOptionId: string | null,
  stored: StoredValue | undefined,
): boolean {
  const O = CaseFieldConditionOperator;
  const present = isPresent(stored);
  switch (operator) {
    case O.IS_EMPTY: return !present;
    case O.IS_NOT_EMPTY: return present;
    default: break;
  }
  if (!stored || !present) return false; // no value → equality/comparison cannot be true

  if (isSingleSelect(stored.fieldType)) {
    if (operator === O.EQUALS) return stored.optionId === conditionOptionId;
    if (operator === O.NOT_EQUALS) return stored.optionId !== conditionOptionId;
    return false;
  }
  if (isMultiSelect(stored.fieldType)) {
    const want = Array.isArray(conditionValue) ? (conditionValue as string[]) : [];
    const has = stored.optionIds;
    const intersects = want.some((w) => has.includes(w));
    if (operator === O.IN) return intersects;
    if (operator === O.NOT_IN) return !intersects;
    return false;
  }
  // scalar
  const sv = stored.valueNumber ?? stored.valueDate ?? stored.valueBoolean ?? stored.valueText;
  let cmp: number | null = null; // stored - condition, for GT/LT
  if (stored.valueNumber != null && typeof conditionValue === 'number') cmp = stored.valueNumber - conditionValue;
  else if (stored.valueDate != null && typeof conditionValue === 'string') cmp = stored.valueDate.getTime() - new Date(conditionValue).getTime();

  switch (operator) {
    case O.EQUALS:
      if (stored.valueDate != null && typeof conditionValue === 'string') return stored.valueDate.getTime() === new Date(conditionValue).getTime();
      return sv === conditionValue;
    case O.NOT_EQUALS:
      if (stored.valueDate != null && typeof conditionValue === 'string') return stored.valueDate.getTime() !== new Date(conditionValue).getTime();
      return sv !== conditionValue;
    case O.GREATER_THAN: return cmp != null && cmp > 0;
    case O.LESS_THAN: return cmp != null && cmp < 0;
    default: return false;
  }
}
