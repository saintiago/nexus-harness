import { z } from 'zod';

/**
 * The JSON data Memory stores and exchanges: optional note provenance, retrieval evidence and
 * receipt contents. Values are plain JSON without cycles or non-finite numbers, so a receipt can
 * carry the same provenance a note carries.
 */

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/**
 * The stable canonical JSON representation of one value: object keys sorted, array order kept and
 * no insignificant whitespace. Source identity digests use it so equal data has one spelling.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(',')}]`;
  }
  const properties = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, element]) => `${JSON.stringify(key)}:${canonicalJson(element)}`);
  return `{${properties.join(',')}}`;
}
