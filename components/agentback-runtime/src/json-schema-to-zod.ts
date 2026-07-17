// Rebuild a Zod validator from a CapabilityContract's stored JSON Schema (tool-projection.md
// "Zod rebuilt at the boundary", ADR-017 + ADR-020). Contracts cross into the agent plane as plain
// JSON; agentback's `@tool` needs a real `SchemaLike` (= ZodType | StandardSchemaV1 — a raw JSON
// Schema object is NOT accepted), so the projector reconstitutes Zod here.
//
// TWO RULES, both load-bearing:
//  1. NEVER produce a validator weaker than the authored contract. tool-projection.md's Open Question
//     flags the round-trip as lossy for constructs that don't serialize; a silent degrade would hand
//     the model a validator weaker than the contract, so anything we cannot faithfully rebuild THROWS
//     and the projector skips + reports that capability rather than shipping a hole.
//  2. Handle what the platform ACTUALLY emits. Contracts are Zod-first with JSON Schema generated
//     from Zod (ADR-020), and that generator emits `$schema`, `format` + `pattern`, numeric bounds,
//     `default`, and `additionalProperties:false`. An allow-list narrower than the generator's output
//     would reject every spec-faithful contract and silently vanish its tool from the agent's tool
//     set — the same failure mode as rule 1, one level up.
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

/** Carry no validation semantics — safe to ignore (dropping them cannot weaken the validator). */
const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'examples', 'readOnly', 'writeOnly']);

/** Keywords this rebuilder actually enforces. Anything outside both sets throws. */
const APPLIED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'format',
  'pattern',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'nullable',
]);

// Zod's format schemas (ZodEmail, ZodUUID, ZodISODate, …) are siblings of ZodString rather than
// subtypes, but all expose the string checks this module applies. This is the narrow structural
// surface we need from any of them.
interface StringLike {
  min(n: number): StringLike;
  max(n: number): StringLike;
  regex(r: RegExp): StringLike;
}

/**
 * JSON Schema `format` → the equivalent Zod string schema (Zod's own format constructors, so the
 * check matches what the authoring side used). An unknown format THROWS: silently ignoring it would
 * hand the model a plain string where the contract demanded a structured one.
 */
function baseForFormat(format: string | undefined, path: string): StringLike {
  switch (format) {
    case undefined:
      return z.string();
    case 'email':
      return z.email();
    case 'uuid':
      return z.uuid();
    case 'uri':
    case 'url':
      return z.url();
    case 'date-time':
      return z.iso.datetime({offset: true, local: true});
    case 'date':
      return z.iso.date();
    case 'time':
      return z.iso.time();
    case 'ipv4':
      return z.ipv4();
    case 'ipv6':
      return z.ipv6();
    default:
      throw new UnsupportedSchemaError(path, `unknown string format '${format}'`);
  }
}

function buildString(node: Json, path: string): z.ZodTypeAny {
  let s = baseForFormat(typeof node.format === 'string' ? node.format : undefined, path);
  if (typeof node.minLength === 'number') s = s.min(node.minLength);
  if (typeof node.maxLength === 'number') s = s.max(node.maxLength);
  // The generator emits `pattern` ALONGSIDE `format`; applying both just adds an equivalent check.
  if (typeof node.pattern === 'string') s = s.regex(new RegExp(node.pattern));
  return s as unknown as z.ZodTypeAny;
}

function buildNumber(node: Json, isInt: boolean): z.ZodTypeAny {
  let n = z.number();
  if (isInt) n = n.int();
  if (typeof node.minimum === 'number') n = n.min(node.minimum);
  if (typeof node.maximum === 'number') n = n.max(node.maximum);
  if (typeof node.exclusiveMinimum === 'number') n = n.gt(node.exclusiveMinimum);
  if (typeof node.exclusiveMaximum === 'number') n = n.lt(node.exclusiveMaximum);
  if (typeof node.multipleOf === 'number') n = n.multipleOf(node.multipleOf);
  return n;
}

function scalar(node: Json, path: string): z.ZodTypeAny {
  switch (node.type) {
    case 'string':
      return buildString(node, path);
    case 'number':
      return buildNumber(node, false);
    case 'integer':
      return buildNumber(node, true);
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    default:
      throw new UnsupportedSchemaError(path, `unknown type ${JSON.stringify(node.type)}`);
  }
}

function buildObject(node: Json, path: string): z.ZodTypeAny {
  const extra = node.additionalProperties;

  // No `properties` → an open record; the contract asserts nothing about its keys.
  if (node.properties === undefined) {
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      return z.record(z.string(), jsonSchemaToZod(extra, `${path}{}`));
    }
    return z.record(z.string(), z.unknown());
  }
  if (typeof node.properties !== 'object' || node.properties === null) {
    throw new UnsupportedSchemaError(path, 'properties is not an object');
  }

  const required = new Set<string>(
    Array.isArray(node.required) ? (node.required as unknown[]).filter((r): r is string => typeof r === 'string') : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, sub] of Object.entries(node.properties as Json)) {
    const built = jsonSchemaToZod(sub, path ? `${path}.${key}` : key);
    // A `default` makes an absent key resolvable, so it is NOT optional — dropping the default would
    // hand the provider `undefined` where the contract guaranteed a value.
    const hasDefault = sub && typeof sub === 'object' && 'default' in (sub as Json);
    shape[key] = required.has(key) || hasDefault ? built : built.optional();
  }

  // `false` REJECTS unknown keys; a bare z.object() only strips them (weaker than the contract).
  if (extra === false) return z.strictObject(shape);
  if (extra === true) return z.looseObject(shape);
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    return z.object(shape).catchall(jsonSchemaToZod(extra, `${path}{}`));
  }
  return z.object(shape); // absent → strip unknown keys
}

/**
 * Convert one JSON Schema node to Zod. Supports the subset the platform's Zod→JSON-Schema generator
 * emits; every other keyword (oneOf/anyOf/allOf/$ref/patternProperties/…) throws rather than degrade.
 */
export function jsonSchemaToZod(schema: unknown, path = ''): z.ZodTypeAny {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new UnsupportedSchemaError(path, 'node is not a JSON Schema object');
  }
  const node = schema as Json;

  for (const key of Object.keys(node)) {
    if (!APPLIED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      throw new UnsupportedSchemaError(path, `keyword '${key}' is outside the projector allow-list`);
    }
  }

  const withDefault = (built: z.ZodTypeAny): z.ZodTypeAny =>
    'default' in node ? built.default(node.default as never) : built;

  if ('const' in node) return withDefault(z.literal(node.const as never));

  // `enum` is authoritative over `type` when both are present.
  if (Array.isArray(node.enum)) {
    const values = node.enum;
    if (values.length === 0) throw new UnsupportedSchemaError(path, 'empty enum');
    if (!values.every(v => typeof v === 'string')) {
      throw new UnsupportedSchemaError(path, 'only string enums are supported');
    }
    return withDefault(z.enum(values as [string, ...string[]]));
  }

  let built: z.ZodTypeAny;
  if (node.type === 'object') {
    built = buildObject(node, path);
  } else if (node.type === 'array') {
    // `items` omitted → an array of anything; the contract asserts only arrayness.
    let arr = z.array(node.items === undefined ? z.unknown() : jsonSchemaToZod(node.items, `${path}[]`));
    if (typeof node.minItems === 'number') arr = arr.min(node.minItems);
    if (typeof node.maxItems === 'number') arr = arr.max(node.maxItems);
    if (node.uniqueItems === true) {
      throw new UnsupportedSchemaError(path, 'uniqueItems is not representable');
    }
    built = arr;
  } else {
    built = scalar(node, path);
  }

  if (node.nullable === true) built = built.nullable();
  return withDefault(built);
}
