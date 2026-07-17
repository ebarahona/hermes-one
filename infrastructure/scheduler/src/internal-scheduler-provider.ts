// @platform-internal/scheduler — internal-scheduler provider (none plane). Named by the specs' own
// canonical examples (database/table-catalog.md:644, admin/agent-engine-and-capability-editors.md:316)
// and realizes the platform capability appointment.slot.read. There is no appointment/slot table in the
// canonical 21-table catalog, so this is the ADR-013 "genuinely new platform capability" code exception —
// a real deployment resolves slots from the tenant's own scheduler vendor behind this same
// ProviderAdapter port. Until that vendor adapter exists, slots are read straight off
// ProviderExecutionContext.config (the spec's provider configKey seam) — never a platform table.
import {
  PlatformErrorException,
  type CapabilityName,
  type IsoTimestamp,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderStatus,
} from '@platform/contracts';

/** Comma-separated fallback when ctx.config.slotTemplates is absent. */
const DEFAULT_SLOT_TEMPLATES = '14:00:00-05:00,15:30:00-05:00';

export interface SlotReadInput {
  date: string;
  serviceType?: string;
}

export interface SlotReadResult {
  slots: string[];
}

/** Config-driven appointment.slot.read stand-in — see file header for why this isn't table-backed. */
export class InternalSchedulerProvider
  implements ProviderAdapter<SlotReadInput, SlotReadResult>
{
  readonly providerId = 'internal-scheduler';
  readonly capability = 'appointment.slot.read' as CapabilityName;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async status(): Promise<ProviderStatus> {
    return {
      providerId: this.providerId,
      health: 'healthy',
      circuit: 'closed',
      lastCheckedAt: this.clock().toISOString() as IsoTimestamp,
    };
  }

  async execute(input: SlotReadInput, ctx: ProviderExecutionContext): Promise<SlotReadResult> {
    if (!input.date || typeof input.date !== 'string') {
      throw new PlatformErrorException({
        category: 'validation',
        code: 'validation_failed',
        message: 'appointment.slot.read requires a non-empty date.',
        issues: [],
        retryable: false,
        httpStatus: 422,
      });
    }
    const templates = (ctx.config.slotTemplates ?? DEFAULT_SLOT_TEMPLATES)
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
    return {slots: templates.map(template => `${input.date}T${template}`)};
  }
}
