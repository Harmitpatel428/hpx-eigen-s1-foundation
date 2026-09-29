import { CaseFieldType, CaseFieldConditionOperator } from '@prisma/client';
import { ValidationError, BusinessRuleViolationError } from '../types/exceptions';

// ─── Type groupings ─────────────────────────────────────────────────
const NUMERIC_TYPES = new Set<CaseFieldType>([
  CaseFieldType.NUMBER, CaseFieldType.DECIMAL, CaseFieldType.CURRENCY, CaseFieldType.PERCENTAGE,
]);
const DATE_TYPES = new Set<CaseFieldType>([CaseFieldType.DATE, CaseFieldType.DATETIME]);
const STRINGLIKE_TYPES = new Set<CaseFieldType>([
  CaseFieldType.TEXT, CaseFieldType.TEXTAREA, CaseFieldType.EMAIL, CaseFieldType.PHONE, CaseFieldType.URL,
]);
const REFERENCE_TYPES = new Set<CaseFieldType>([
  CaseFieldType.USER_REFERENCE, CaseFieldType.DEPARTMENT_REFERENCE,
  CaseFieldType.CASE_REFERENCE, CaseFieldType.DOCUMENT_REFERENCE,
]);

export function isSelectType(type: CaseFieldType): boolean {
  return type === CaseFieldType.SELECT || type === CaseFieldType.MULTI_SELECT;
}

// ─── validationRules JSON — allowed keys & value types per field type ─
type RuleSpec = Record<string, 'number' | 'string' | 'boolean'>;

function ruleSpecFor(type: CaseFieldType): RuleSpec {
  if (type === CaseFieldType.TEXT || type === CaseFieldType.TEXTAREA) {
    return { minLength: 'number', maxLength: 'number', pattern: 'string' };
  }
  if (NUMERIC_TYPES.has(type)) {
    return { min: 'number', max: 'number' };
  }
  if (DATE_TYPES.has(type)) {
    return { minDate: 'string', maxDate: 'string' };
  }
  if (type === CaseFieldType.MULTI_SELECT) {
    return { minSelections: 'number', maxSelections: 'number' };
  }
  return {}; // BOOLEAN, SELECT, TIME, EMAIL, PHONE, URL, reference types
}

/** Throws ValidationError (400) on unknown keys, wrong value types, or min>max. */
export function validateValidationRules(type: CaseFieldType, rules: unknown): void {
  if (rules === null || rules === undefined) return;
  if (typeof rules !== 'object' || Array.isArray(rules)) {
    throw new ValidationError('validationRules must be an object.');
  }
  const spec = ruleSpecFor(type);
  const obj = rules as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (!(key in spec)) {
      throw new ValidationError(`validationRules.${key} is not allowed for type ${type}.`);
    }
    if (typeof val !== spec[key]) {
      throw new ValidationError(`validationRules.${key} must be a ${spec[key]}.`);
    }
  }
  if (typeof obj.minLength === 'number' && typeof obj.maxLength === 'number' && obj.minLength > obj.maxLength) {
    throw new ValidationError('validationRules.minLength must be <= maxLength.');
  }
  if (typeof obj.min === 'number' && typeof obj.max === 'number' && obj.min > obj.max) {
    throw new ValidationError('validationRules.min must be <= max.');
  }
  if (typeof obj.minSelections === 'number' && typeof obj.maxSelections === 'number' && obj.minSelections > obj.maxSelections) {
    throw new ValidationError('validationRules.minSelections must be <= maxSelections.');
  }
}

// ─── visibility JSON — shape only, no referential integrity ──────────
export function validateVisibility(visibility: unknown): void {
  if (visibility === null || visibility === undefined) return;
  if (typeof visibility !== 'object' || Array.isArray(visibility)) {
    throw new ValidationError('visibility must be an object.');
  }
  const obj = visibility as Record<string, unknown>;
  const allowed = new Set(['hidden', 'departmentIds', 'roles']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new ValidationError(`visibility.${key} is not allowed.`);
  }
  if ('hidden' in obj && typeof obj.hidden !== 'boolean') {
    throw new ValidationError('visibility.hidden must be a boolean.');
  }
  for (const arrKey of ['departmentIds', 'roles'] as const) {
    if (arrKey in obj) {
      const arr = obj[arrKey];
      if (!Array.isArray(arr) || !arr.every((v) => typeof v === 'string')) {
        throw new ValidationError(`visibility.${arrKey} must be an array of strings.`);
      }
    }
  }
}

// ─── Operator ↔ field-type compatibility ─────────────────────────────
export function operatorAllowedForType(type: CaseFieldType, op: CaseFieldConditionOperator): boolean {
  const O = CaseFieldConditionOperator;
  const allowed = (...ops: CaseFieldConditionOperator[]): boolean => ops.includes(op);
  if (type === CaseFieldType.MULTI_SELECT) {
    return allowed(O.IN, O.NOT_IN, O.IS_EMPTY, O.IS_NOT_EMPTY);
  }
  if (type === CaseFieldType.BOOLEAN || type === CaseFieldType.SELECT) {
    return allowed(O.EQUALS, O.NOT_EQUALS, O.IS_EMPTY, O.IS_NOT_EMPTY);
  }
  if (NUMERIC_TYPES.has(type) || DATE_TYPES.has(type)) {
    return allowed(O.EQUALS, O.NOT_EQUALS, O.GREATER_THAN, O.LESS_THAN, O.IS_EMPTY, O.IS_NOT_EMPTY);
  }
  // TIME, and all string-like / reference types
  if (type === CaseFieldType.TIME || STRINGLIKE_TYPES.has(type) || REFERENCE_TYPES.has(type)) {
    return allowed(O.EQUALS, O.NOT_EQUALS, O.IS_EMPTY, O.IS_NOT_EMPTY);
  }
  return false;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const ISO_TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates conditionValue for a scalar operator (EQUALS/NOT_EQUALS/GREATER_THAN/LESS_THAN)
 * against the condition field's type. SELECT/MULTI_SELECT and IS_EMPTY/IS_NOT_EMPTY are
 * handled by the caller (they use conditionOptionId / null). Throws ValidationError.
 */
export function validateScalarConditionValue(type: CaseFieldType, value: unknown): void {
  if (NUMERIC_TYPES.has(type)) {
    if (typeof value !== 'number') throw new ValidationError('conditionValue must be a number for this field type.');
    return;
  }
  if (type === CaseFieldType.BOOLEAN) {
    if (typeof value !== 'boolean') throw new ValidationError('conditionValue must be a boolean.');
    return;
  }
  if (DATE_TYPES.has(type)) {
    if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) throw new ValidationError('conditionValue must be an ISO date string.');
    return;
  }
  if (type === CaseFieldType.TIME) {
    if (typeof value !== 'string' || !ISO_TIME_RE.test(value)) throw new ValidationError('conditionValue must be an ISO time string.');
    return;
  }
  if (REFERENCE_TYPES.has(type)) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw new ValidationError('conditionValue must be a uuid string.');
    return;
  }
  if (STRINGLIKE_TYPES.has(type)) {
    if (typeof value !== 'string') throw new ValidationError('conditionValue must be a string.');
    return;
  }
  throw new ValidationError('Unsupported field type for a scalar condition value.');
}

// ─── Option parent-chain cycle detection ─────────────────────────────
/**
 * Given the full set of option→parent edges for a field, decide whether pointing
 * `optionId` at `newParentId` would create a cycle (or is a self-parent).
 * `parents` maps optionId -> parentOptionId|null (current DB state, excluding the edit).
 * Throws ValidationError on self-parent or cycle.
 */
export function assertNoOptionCycle(
  optionId: string | null,
  newParentId: string | null,
  parents: Map<string, string | null>,
): void {
  if (!newParentId) return;
  if (optionId && newParentId === optionId) {
    throw new ValidationError('An option cannot be its own parent.');
  }
  // Walk up from newParentId; if we reach optionId, the edit closes a cycle.
  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (optionId && cursor === optionId) {
      throw new ValidationError('Option parent relationship would create a cycle.');
    }
    if (seen.has(cursor)) {
      // Pre-existing cycle in the data — stop rather than loop forever.
      throw new ValidationError('Option parent relationship would create a cycle.');
    }
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
}

// ─── Phase 5: SET_DEFAULT payload validation ────────────────────────
// Shape by target field type: SELECT {optionId}, MULTI_SELECT {optionIds[]},
// everything else {value:<primitive>}. Option membership/selectability is a
// DB concern checked by the service; here we validate shape + primitive type.
export function validateDefaultPayload(type: CaseFieldType, payload: unknown): void {
  if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('defaultPayload must be an object.');
  }
  const p = payload as Record<string, unknown>;
  if (type === CaseFieldType.SELECT) {
    if (typeof p.optionId !== 'string') throw new ValidationError('defaultPayload.optionId must be a string for a SELECT field.');
    return;
  }
  if (type === CaseFieldType.MULTI_SELECT) {
    if (!Array.isArray(p.optionIds) || p.optionIds.length === 0 || !p.optionIds.every((x) => typeof x === 'string')) {
      throw new ValidationError('defaultPayload.optionIds must be a non-empty array of strings for a MULTI_SELECT field.');
    }
    return;
  }
  if (!('value' in p)) throw new ValidationError('defaultPayload.value is required.');
  // Reuse the scalar validator (numeric/date/time/boolean/string/reference).
  validateScalarConditionValue(type, p.value);
}

// ─── Phase 5: rule-graph cycle detection (config-time only) ─────────
// Each rule is a directed edge conditionFieldId -> targetFieldId. Adding
// `newEdge` must not close a cycle. Self-reference is rejected earlier.
export function assertNoRuleCycle(
  edges: Array<{ from: string; to: string }>,
  newEdge: { from: string; to: string },
): void {
  const adj = new Map<string, string[]>();
  const add = (f: string, t: string) => { const l = adj.get(f) ?? []; l.push(t); adj.set(f, l); };
  for (const e of edges) add(e.from, e.to);
  add(newEdge.from, newEdge.to);
  // A new edge from->to closes a cycle iff `from` is reachable from `to`.
  const seen = new Set<string>();
  const stack = [newEdge.to];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === newEdge.from) throw new BusinessRuleViolationError('Rule dependency cycle detected.');
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) ?? []) stack.push(m);
  }
}
