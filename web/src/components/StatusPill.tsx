import type { BookingStatus } from "../api";

const STATUS_CLASS: Record<BookingStatus, string> = {
  RESERVED: "pill-gray",
  POS_PENDING: "pill-amber",
  PAID: "pill-blue",
  PICKED_UP: "pill-purple",
  RETURNED: "pill-teal",
  COMPLETED: "pill-green",
  CANCELLED: "pill-red",
};

const STATUS_LABEL: Record<BookingStatus, string> = {
  RESERVED: "Reserved",
  POS_PENDING: "POS pending",
  PAID: "Paid",
  PICKED_UP: "Picked up",
  RETURNED: "Returned",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function StatusPill({ status }: { status: BookingStatus | string }) {
  const cls = STATUS_CLASS[status as BookingStatus] ?? "pill-gray";
  const label = STATUS_LABEL[status as BookingStatus] ?? status;
  return <span className={`pill ${cls}`}>{label}</span>;
}
