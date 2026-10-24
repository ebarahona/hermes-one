// Operator registry — resolves an operator name to its pure implementation.
// The platform discovers operators via the `rule.operator` LB4 extension type;
// this in-memory registry is the pure core the runtime and tests use.
import type {RuleOperator, SemVer} from '@hermes-one/contracts';
import {BUILTIN_OPERATORS} from './operators.js';

export interface OperatorRegistry {
  readonly version: SemVer;
  resolve(op: string): RuleOperator | undefined;
  /** Version of a named operator, for plan pinning (operatorRefs). */
  versionOf(op: string): SemVer | undefined;
  names(): string[];
}

export class InMemoryOperatorRegistry implements OperatorRegistry {
  private readonly byName = new Map<string, RuleOperator>();

  constructor(
    readonly version: SemVer,
    operators: RuleOperator[] = BUILTIN_OPERATORS,
  ) {
    for (const o of operators) {
      if (this.byName.has(o.spec.op)) {
        throw new Error(`OperatorRegistry: duplicate operator '${o.spec.op}'`);
      }
      this.byName.set(o.spec.op, o);
    }
  }

  resolve(op: string): RuleOperator | undefined {
    return this.byName.get(op);
  }

  versionOf(op: string): SemVer | undefined {
    return this.byName.get(op)?.spec.version;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}

/** Convenience: a registry of just the built-in core operators. */
export function builtinRegistry(version = '1.0.0' as SemVer): OperatorRegistry {
  return new InMemoryOperatorRegistry(version);
}
