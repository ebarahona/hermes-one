// EventOutboxPublisherLoop — `platform.data.event-outbox-publisher` (events/event-envelope.md):
// the poll loop that drains `event.event_outbox` on a cadence (outboxPollIntervalMs) and fans each
// pending row out as an EventEnvelope through the injected `EventPublisher` (Redis pub/sub today,
// a broker adapter later — the config's documented, not-yet-implemented `broker` target).
//
// FLAGGED: the loop iterates an INJECTED tenant list and drains each tenant under its own RLS scope,
// because the cross-tenant relay role is an unresolved spec question (row-level-security.md Open
// Questions — a bypass-capable role is exactly what the RLS self-check exists to keep out). The
// tenant list is config today (HERMES_OUTBOX_TENANTS); the real source is the tenant registry (CT1/CT2).
import type {EventPublisher, SemVer, TenantId} from '@platform/contracts';
import type {DrizzleEventOutboxRepository, OutboxDrainResult} from './event-outbox-repository.js';

export interface OutboxPublisherConfig {
  /** EventEnvelopeConfig.outboxPollIntervalMs (default 1000). */
  pollIntervalMs: number;
  /** Rows claimed per tenant per pass. */
  batchSize: number;
  /** EventEnvelopeConfig.schemaVersionByType — per-event-type payload schema version. */
  schemaVersionByType: Record<string, string>;
}

export const DEFAULT_OUTBOX_PUBLISHER_CONFIG: OutboxPublisherConfig = {
  pollIntervalMs: 1000,
  batchSize: 50,
  schemaVersionByType: {},
};

export class EventOutboxPublisherLoop {
  private timer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(
    private readonly repo: DrizzleEventOutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly tenants: readonly TenantId[],
    private readonly config: OutboxPublisherConfig = DEFAULT_OUTBOX_PUBLISHER_CONFIG,
  ) {}

  private schemaVersionFor = (eventType: string): SemVer =>
    (this.config.schemaVersionByType[eventType] ?? '1.0.0') as SemVer;

  /** One pass over every configured tenant. Safe to call directly (tests, drain-on-demand). */
  async drainOnce(): Promise<OutboxDrainResult> {
    const total: OutboxDrainResult = {published: 0, failed: 0};
    for (const tenantId of this.tenants) {
      const r = await this.repo.drainPending(
        tenantId,
        this.config.batchSize,
        envelope => this.publisher.publish(envelope),
        this.schemaVersionFor,
      );
      total.published += r.published;
      total.failed += r.failed;
    }
    return total;
  }

  /** Start the cadence. The timer is unref'd so it never holds a worker process open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.draining) return; // never overlap passes
      this.draining = true;
      void this.drainOnce()
        .catch(err => console.error('outbox publisher pass failed:', err))
        .finally(() => {
          this.draining = false;
        });
    }, this.config.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
