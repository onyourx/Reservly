// Typed fetch wrapper + API types for the Booking Desk admin SPA.
// Contract: apps/booking/API.md (v1).

export interface Store {
  id: string;
  code: string;
  name: string;
  city: string;
}

export interface Health {
  ok: boolean;
  navMode: "mock" | "live";
  shopifyConfigured: boolean;
}

export type ProductType = "RENTAL" | "COURSE";

export interface KitItem {
  itemNo: string;
  description: string;
  qty: number;
}

export interface PriceTier {
  description: string;
  price: number;
}

export interface Product {
  id: string;
  productNo: string;
  type: ProductType;
  name: string;
  nameFr: string;
  webDescEn: string;
  webDescFr: string;
  imageUrl: string;
  activityType: string;
  durationType: string;
  duration: number;
  defaultUnitPrice: number;
  securityDeposit: number;
  retailItem: string;
  fixedLocation: string;
  availableOnWeb: boolean;
  minQty: number;
  maxQty: number;
  shopifyProductId: string | null;
  kit: KitItem[];
  prices: PriceTier[];
  sessions?: Session[];
}

export interface Session {
  id: string;
  productId: string;
  productNo: string;
  seriesId: string | null;
  startsAt: string;
  endsAt: string;
  storeId: string;
  roomId: string | null;
  trainerIds: string[];
  capacity: number;
  booked: number;
  instanceNo: number;
  instanceCount: number;
  productName?: string;
}

export type ResourceType = "ROOM" | "TRAINER";

export interface Resource {
  id: string;
  type: ResourceType;
  name: string;
  storeId: string;
  notes: string;
}

export interface AvailabilitySlot {
  date: string;
  from: string;
  to: string;
}

export interface RentalAvailability {
  available: boolean;
  perDay: { date: string; qty: number }[];
}

export interface CourseSlot {
  sessionId: string;
  date: string;
  time: string;
  endsAt: string;
  storeId: string;
  location: string;
  capacity: number;
  booked: number;
  remaining: number;
  trainers: string[];
}

export type QuoteLine =
  | { type: "RENTAL"; productNo: string; storeId: string; from: string; to: string; qty: number }
  | { type: "COURSE"; sessionId: string; qty: number };

export interface QuotedLine {
  type: ProductType;
  productNo?: string;
  sessionId?: string;
  storeId?: string;
  from?: string;
  to?: string;
  qty: number;
  productName: string;
  days?: number;
  unitPrice: number;
  lineTotal: number;
  deposit: number;
}

export interface Quote {
  lines: QuotedLine[];
  subtotal: number;
  deposit: number;
  currency: string;
}

export type BookingStatus =
  | "RESERVED"
  | "POS_PENDING"
  | "PAID"
  | "PICKED_UP"
  | "RETURNED"
  | "COMPLETED"
  | "CANCELLED";

export type BookingType = "RENTAL" | "COURSE" | "MIXED";
export type BookingChannel = "STAFF" | "WEB";

export interface Customer {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  b2b: boolean;
}

export interface DamageRow {
  itemNo: string;
  note: string;
  charge: number;
}

export interface BookingLine {
  id: string;
  type: ProductType;
  productNo: string;
  productName: string;
  sessionId?: string;
  storeId: string;
  from: string;
  to: string;
  qty: number;
  days?: number;
  unitPrice: number;
  lineTotal: number;
  deposit: number;
  status: string;
  activityNo?: string;
  bookingRef?: string;
  inspectionOut?: string;
  inspectionIn?: string;
  damages: DamageRow[];
}

export interface BookingEvent {
  at: string;
  type: string;
  detail?: string;
  bookingId?: string;
}

export interface NavRef {
  lineId: string;
  activityNo: string;
  bookingRef: string;
  sellingItem: string;
}

export interface Booking {
  id: string;
  ref: string;
  type: BookingType;
  status: BookingStatus;
  channel: BookingChannel;
  storeId: string;
  customer: Customer;
  lines: BookingLine[];
  subtotal: number;
  deposit: number;
  total: number;
  posTotal: number | null;
  refundDue?: number;
  currency: string;
  navRefs: NavRef[];
  posReceiptNo: string | null;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  idOnFile: boolean;
  contractSignedAt: string | null;
  notes: string;
  createdAt: string;
  events: BookingEvent[];
}

/** Lists return a lighter shape; lines/events may be absent. */
export type BookingLite = Omit<Booking, "lines" | "events" | "navRefs"> & {
  lines?: BookingLine[];
  events?: BookingEvent[];
};

export interface DashboardData {
  date: string;
  pickups: BookingLite[];
  returns: BookingLite[];
  classes: { session: Session; productName: string; booked: number; capacity: number }[];
  stats: {
    activeRentals: number;
    todayRevenue: number;
    upcoming7d: number;
    openDeposits: number;
  };
}

export interface Settings {
  navBaseUrl: string;
  navMode: "mock" | "live";
  navUsername: string;
  navDomain: string;
  shopifyShop: string;
  conduitUrl: string;
  posStoreId: string;
  posTerminalId: string;
  posStaffId: string;
  /** Write-only: accepted on PUT, never returned by GET. */
  navPassword?: string;
  shopifyApiSecret?: string;
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

/**
 * Tiny typed fetch wrapper. Non-2xx responses throw `Error(json.error)`
 * (falling back to the HTTP status text).
 */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method: opts.method ?? (hasBody ? "POST" : "GET"),
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data: unknown = await res.json();
      if (
        data &&
        typeof data === "object" &&
        "error" in data &&
        typeof (data as { error: unknown }).error === "string"
      ) {
        message = (data as { error: string }).error;
      }
    } catch {
      /* body was not JSON — keep the status text */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** Build a query string, skipping empty/undefined values. Returns "" or "?a=b&…". */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
