// Rebuild a Zod validator from a CapabilityContract's stored JSON Schema (tool-projection.md
// "Zod rebuilt at the boundary", ADR-017 + ADR-020). Contracts cross into the agent plane as plain
// JSON; agentback's `@tool` needs a real `SchemaLike` (= ZodType | StandardSchemaV1 — a raw JSON
// Schema object is NOT accepted), so the projector reconstitutes Zod here.
//
// Deliberately a SMALL ALLOW-LIST, and it THROWS on anything outside it. tool-projection.md's Open
// Question flags that the JSON-Schema→Zod round-trip is lossy for constructs that don't serialize
// (`.brand()`, custom `.refine()`); a silent degrade would hand the model a validator that is weaker
// than the authored contract, so an unsupported construct is a projection-time failure instead.
import {z} from 'zod';

/** Raised when a contract's JSON Schema uses a construct outside the projector's allow-list. */
export class UnsupportedSchemaError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`unsupported JSON Schema at ${path || '<root>'}: ${reason}`);
    this.name = 'UnsupportedSchemaError';
  }
}

type Json = Record<string, unknown>;

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'title',
  'additionalProperties',
  'format',
  'default',
]);

function scalar(schema: Json, path: string): z.ZodTypeAny {
  switch (schema.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    default:
      throw new UnsupportedSchemaError(path, `unknown type ${JSON.stringify(schema.type)}`);
  }
}

/**
 * Convert one JSON Schema node to Zod. Supports the object/array/scalar/enum subset that authored
 * capability contracts use; every other keyword (oneOf/anyOf/allOf/$ref/patternProperties/…) throws.
 */
export function jsonSchemaToZod(schema: unknown, path = ''): z.ZodTypeAny {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new UnsupportedSchemaError(path, 'node is not a JSON Schema object');
  }
  const node = schema as Json;

  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new UnsupportedSchemaError(path, `keyword '${key}' is outside the projector allow-list`);
    }
  }

  // `enum` is authoritative over `type` when both are present.
  if (Array.isArray(node.enum)) {
    const values = node.enum;
    if (values.length === 0) throw new UnsupportedSchemaError(path, 'empty enum');
    if (!values.every(v => typeof v === 'string')) {
      throw new UnsupportedSchemaError(path, 'only string enums are supported');
    }
    return z.enum(values as [string, ...string[]]);
  }

  if (node.type === 'object') {
    // A property-less object is an open record — the contract asserts nothing about its keys.
    if (node.properties === undefined) return z.record(z.string(), z.unknown());
    if (typeof node.properties !== 'object' || node.properties === null) {
      throw new UnsupportedSchemaError(path, 'properties is not an object');
    }
    const required = new Set<string>(
      Array.isArray(node.required) ? (node.required as unknown[]).filter((r): r is string => typeof r === 'string') : [],
    );
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, sub] of Object.entries(node.properties as Json)) {
      const built = jsonSchemaToZod(sub, path ? `${path}.${key}` : key);
      shape[key] = required.has(key) ? built : built.optional();
    }
    // z.object() strips unknown keys, which matches `additionalProperties: false`. An explicit
    // `true` (open object) is NOT representable that way — flag rather than silently narrow.
    if (node.additionalProperties === true) {
      throw new UnsupportedSchemaError(path, 'additionalProperties: true is not representable');
    }
    return z.object(shape);
  }

  if (node.type === 'array') {
    // `items` omitted → an array of anything; the contract asserts only arrayness.
    const items = node.items === undefined ? z.unknown() : jsonSchemaToZod(node.items, `${path}[]`);
    return z.array(items);
  }

  return scalar(node, path);
}
