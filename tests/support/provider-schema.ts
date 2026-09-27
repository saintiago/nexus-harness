/**
 * Test support: check one JSON Schema against the coding provider's strict structured-output
 * requirements, independently of the conversion that produced the schema. The checks mirror the
 * documented requirements: the root is an object and not an anyOf, every object property is
 * required, every object sets additionalProperties to false, every array declares its items and
 * the composition keywords the provider does not support are absent. A schema comparison with its
 * own conversion cannot show these; this can.
 */

/** Keywords the provider's structured-output subset does not support. */
const unsupportedKeywords = [
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collect every problem one schema node and its subschemas have. */
function collectProblems(node: unknown, path: string, problems: string[]): void {
  if (!isRecord(node)) {
    problems.push(`${path}: not a schema object`);
    return;
  }
  for (const keyword of unsupportedKeywords) {
    if (keyword in node) {
      problems.push(`${path}: unsupported keyword "${keyword}"`);
    }
  }
  const declaresShape =
    'type' in node || 'anyOf' in node || 'enum' in node || 'const' in node || '$ref' in node;
  if (!declaresShape) {
    problems.push(`${path}: declares no type, anyOf, enum, const or $ref`);
  }
  const anyOf = node['anyOf'];
  if (Array.isArray(anyOf)) {
    anyOf.forEach((branch, index) => {
      collectProblems(branch, `${path}.anyOf[${String(index)}]`, problems);
    });
  }
  if (node['type'] === 'object') {
    const properties = node['properties'];
    if (!isRecord(properties)) {
      problems.push(`${path}: object without properties`);
    } else {
      if (node['additionalProperties'] !== false) {
        problems.push(`${path}: additionalProperties is not false`);
      }
      const required = Array.isArray(node['required']) ? node['required'] : [];
      for (const [name, property] of Object.entries(properties)) {
        if (!required.includes(name)) {
          problems.push(`${path}.${name}: not required`);
        }
        collectProblems(property, `${path}.${name}`, problems);
      }
      for (const name of required) {
        if (typeof name !== 'string' || !(name in properties)) {
          problems.push(`${path}: required names undeclared property ${JSON.stringify(name)}`);
        }
      }
    }
  }
  if (node['type'] === 'array') {
    if (!('items' in node)) {
      problems.push(`${path}: array without items`);
    } else {
      collectProblems(node['items'], `${path}[]`, problems);
    }
  }
  const definitions = node['$defs'];
  if (isRecord(definitions)) {
    for (const [name, definition] of Object.entries(definitions)) {
      collectProblems(definition, `${path}.$defs.${name}`, problems);
    }
  }
}

/** The strict structured-output requirements the supplied JSON Schema breaks; empty when it is sound. */
export function strictSchemaProblems(schema: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(schema) || schema['type'] !== 'object' || 'anyOf' in schema) {
    problems.push('<root>: the provider requires an object root without anyOf');
  }
  collectProblems(schema, '<root>', problems);
  return problems;
}
