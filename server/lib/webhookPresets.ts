export const PRESETS: Record<string, { label: string; events: string[] }> = {
  "rental-lifecycle": {
    label: "Rental Lifecycle",
    events: ["booking.created", "booking.picked_up", "booking.returned", "booking.completed", "booking.cancelled", "booking.rescheduled", "rental.maintenance_due"],
  },
  "courses-tickets": {
    label: "Courses & Tickets",
    events: ["booking.created", "booking.checked_in", "booking.no_show", "booking.rescheduled", "booking.cancelled", "booking.reminder_due", "waitlist.availability_opened"],
  },
  "payments-fees": {
    label: "Payments & Fees",
    events: ["booking.pos_pushed", "booking.reconciled", "booking.no_show_fee_waived", "nav.reservation_failed", "nav.cancel_failed"],
  },
  "customer-self-service": {
    label: "Customer Self-Service",
    events: ["booking.created", "booking.management_link_created", "booking.signature_requested", "booking.contract_signed", "booking.rescheduled"],
  },
  "extensions": {
    label: "Extensions",
    events: ["extension.requested", "extension.approved", "extension.rejected", "extension.applied"],
  },
  "everything": {
    label: "All Events",
    events: ["*"],
  },
};

export const ALL_EVENTS = [
  // Booking lifecycle
  "booking.created", "booking.picked_up", "booking.returned", "booking.completed", "booking.cancelled",
  "booking.checked_in", "booking.rescheduled", "booking.no_show", "booking.reminder_due",
  "booking.pos_pushed", "booking.reconciled", "booking.no_show_fee_waived",
  "booking.signature_requested", "booking.contract_signed",
  "booking.management_link_created",
  // Rental & NAV
  "rental.maintenance_due",
  "nav.reservation_failed", "nav.cancel_failed",
  // Extensions
  "extension.requested", "extension.approved", "extension.rejected", "extension.applied",
  // Shopify + other
  "shopify.product_pushed",
  "waitlist.availability_opened",
  // Testing
  "booking.test",
];

export function getAllEmittedEvents(): string[] {
  return ALL_EVENTS;
}

export function findMatchingPreset(events: string[]): string | null {
  const normalized = Array.from(new Set(events)).sort();
  for (const [name, preset] of Object.entries(PRESETS)) {
    const presetEvents = Array.from(new Set(preset.events)).sort();
    if (normalized.length === presetEvents.length && normalized.every((event, index) => event === presetEvents[index])) {
      return name;
    }
  }
  return null;
}
