// De-risking fixtures — real agentback @tool classes exercised by the
// agent-plane validation (ADR-017/018/021). They stand in for capability
// adapters so we can prove tool dispatch / envelope / confirm: against the
// actual pre-1.0 substrate. Tool names follow the platform's
// `domain.resource.action` capability convention.
import {z} from 'zod';
import {mcpServer, tool} from '@agentback/mcp';

/* ----------------------------- read-only tool --------------------------- */

export const SlotReadInput = z.object({
  date: z.string(),
});
export const SlotReadOutput = z.object({
  slots: z.array(z.string()),
});

/* --------------------------- confirm: write tool ------------------------ */

export const BookingCreateInput = z.object({
  slot: z.string(),
  customer: z.string(),
});
export const BookingCreateOutput = z.object({
  bookingId: z.string(),
  slot: z.string(),
});

@mcpServer()
export class SpikeBookingTools {
  /** Read-only capability — no side effect, safe to dispatch directly. */
  @tool('appointment.slot.read', {
    description: 'List open appointment slots for a date.',
    input: SlotReadInput,
    output: SlotReadOutput,
  })
  async readSlots(
    input: z.infer<typeof SlotReadInput>,
  ): Promise<z.infer<typeof SlotReadOutput>> {
    return {
      slots: [`${input.date}T14:00:00-05:00`, `${input.date}T15:30:00-05:00`],
    };
  }

  /**
   * Side-effecting capability, gated by agentback's `confirm:` round-trip: the
   * first call (no `confirmationToken`) is refused with a single-use token;
   * the identical retry carrying the token executes. This is the propose →
   * gate → execute contract the platform relies on (ADR-021 / T8).
   */
  @tool('appointment.booking.create', {
    description:
      'Book an appointment slot (side-effecting; requires confirmation).',
    input: BookingCreateInput,
    output: BookingCreateOutput,
    confirm: true,
  })
  async createBooking(
    input: z.infer<typeof BookingCreateInput>,
  ): Promise<z.infer<typeof BookingCreateOutput>> {
    return {
      bookingId: `bk_${input.slot.replace(/[^0-9]/g, '').slice(0, 8)}`,
      slot: input.slot,
    };
  }
}
