// Structured JSON logging: one LogRecord = one JSON line, tagged with the
// ObservabilityCorrelationContext so traces/metrics/logs join without a correlation table. RedactingLogger
// runs every record through a Redactor before it reaches the sink — PII never leaves raw.
import {type LogLevel, type LogRecord, type Logger, type Redactor} from '@platform/contracts';

const LEVEL_ORDER: Record<LogLevel, number> = {debug: 0, info: 1, warn: 2, error: 3};

/** Emits one JSON line per record at or above `minLevel`. Sink defaults to stdout. */
export class JsonLogger implements Logger {
  constructor(
    private readonly minLevel: LogLevel = 'info',
    private readonly sink: (line: string) => void = line => process.stdout.write(`${line}\n`),
  ) {}

  log(record: LogRecord): void {
    if (LEVEL_ORDER[record.level] < LEVEL_ORDER[this.minLevel]) return;
    this.sink(JSON.stringify(record));
  }
}

/** Wraps a Logger so every record is redacted before it is emitted. */
export class RedactingLogger implements Logger {
  constructor(private readonly inner: Logger, private readonly redactor: Redactor) {}

  log(record: LogRecord): void {
    this.inner.log(this.redactor.redact(record));
  }
}
