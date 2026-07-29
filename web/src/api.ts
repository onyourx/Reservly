// Typed fetch wrapper + API types for the Booking Desk admin SPA.
// Contract: apps/booking/API.md (v1).

export interface Store {
  id: string;
  code: string;
  name: string;
  city: string;
}

export interface StaffUser {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "member";
  perms: {
    products: boolean;
    bookings: boolean;
    sessions: boolean;
    reports: boolean;
    availability: boolean;
  };
  storeIds: "*" | string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Health {
  ok: boolean;
  navMode: "mock" | "live";
  shopifyConfigured: boolean;
  sftpConfigured: boolean;
}

export type ProductType = "RENTAL" | "COURSE" | "SERVICE";

export interface BookingField {
  id: string;
  label: string;
  type: "text" | "textarea" | "dropdown" | "radio" | "checkbox" | "date" | "number";
  options: string[];
  required: boolean;
  sort: number;
}

export interface KitItem {
  itemNo: string;
  description: string;
  qty: number;
}

export interface PriceTier {
  description: string;
  price: number;
}
export interface ProductAddon {
  id?: string;
  addonProductNo: string;
  name: string;
  price: number;
  maxQty: number;
  required: boolean;
  active: boolean;
  shopifyVariantId: string;
}

export interface StoreQty {
  storeId: string;
  qty: number;
}

export interface Product {
  id: string;
  productNo: string;
  sku: string;
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
  lateFeePerDay: number;
  retailItem: string;
  fixedLocation: string;
  availableOnWeb: boolean;
  minQty: number;
  maxQty: number;
  shopifyProductId: string | null;
  navSyncedAt?: string;
  kit: KitItem[];
  prices: PriceTier[];
  storeQty: StoreQty[];
  sessions?: Session[];
  translations: ProductTranslation[];
  addons: ProductAddon[];
  crossSell?: CrossSellSuggestion[];
  bookingFields: BookingField[];
}

export interface CrossSellSuggestion {
  productNo: string;
  name: string;
  type: ProductType;
  defaultUnitPrice: number;
}

export interface ProductTranslation {
  locale: string;
  name: string;
  description: string;
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
  roomName: string;
  trainerIds: string[];
  trainers: { id: string; name: string }[];
  capacity: number;
  booked: number;
  instanceNo: number;
  instanceCount: number;
  productName?: string;
  deliveryMode: "IN_PERSON" | "VIRTUAL" | "HYBRID";
  meetingUrl: string;
  meetingHostUrl: string;
  zoomMeetingId: string;
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
  | { type: "COURSE"; sessionId: string; qty: number }
  | { type: "SERVICE"; productNo: string; storeId: string; from: string; to: string; qty: number };

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
  checklist: ChecklistItem[];
  units: RentalUnitAssignment[];
  deliveryMode?: "IN_PERSON" | "VIRTUAL" | "HYBRID";
  meetingUrl?: string;
}

export interface RentalUnitAssignment {
  id: string; barcode: string; serialNo: string; status: string; condition: string;
  storeId: string; assignedAt: string; returnedAt?: string;
}

export interface RentalUnit {
  id: string; productId: string; productNo: string; productName: string; storeId: string;
  serialNo: string; barcode: string; status: "AVAILABLE" | "RESERVED" | "ON_RENT" | "SERVICE" | "RETIRED";
  condition: "NEW" | "GOOD" | "FAIR" | "DAMAGED"; notes: string; updatedAt: string;
  usageCount: number; nextServiceUsage: number | null; lastServiceAt: string | null;
  nextServiceAt: string | null; maintenanceDue: boolean;
  unavailability: { id: string; startsAt: string; endsAt: string; reason: string }[];
}

export interface ChecklistItem {
  itemNo: string;
  description: string;
  qty: number;
  checked: boolean;
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
  addons?: { productNo: string; name: string; qty: number; unitPrice: number; shopifyVariantId: string }[];
  checkedInAt?: string;
  noShowAt?: string;
  noShowFee?: number;
  noShowFeeStatus?: string;
  noShowDraftOrderId?: string;
  intakeResponses?: Record<string, unknown>;
  fieldResponses?: Record<string, unknown>;
  termsAcceptedAt?: string;
  rescheduleCount?: number;
  currency: string;
  navRefs: NavRef[];
  posReceiptNo: string | null;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  idOnFile: boolean;
  idLast4?: string;
  idPhotoAt?: string;
  contractSignedAt: string | null;
  signatureName?: string;
  signaturePending?: boolean;
  notes: string;
  createdAt: string;
  events: BookingEvent[];
}

export interface SessionAttendee {
  bookingId: string;
  bookingRef: string;
  customerFirst: string;
  customerLast: string;
  customerEmail: string;
  customerPhone: string;
  qty: number;
  bookingStatus: BookingStatus;
  checkedInAt: string | null;
  noShowAt: string | null;
}

export interface SessionAttendees {
  session: {
    id: string;
    productName: string;
    startsAt: string;
    endsAt: string;
    storeId: string;
    capacity: number;
  };
  attendees: SessionAttendee[];
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

export interface ExtensionRequest {
  id: string;
  bookingRef: string;
  customerEmail: string;
  productName: string;
  oldDateTo: string;
  newDateTo: string;
  price: number;
  status: "REQUESTED" | "APPROVED" | "APPLIED" | "REJECTED";
  decidedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface ExtensionRequestsResponse {
  requests: ExtensionRequest[];
}

export type OperationPhase = "PICKUP" | "RETURN" | "CLASS" | "ON_RENT";
export interface OperationsData {
  date: string;
  items: {
    id: string; bookingId: string; ref: string; type: ProductType; phase: OperationPhase;
    startsAt: string; endsAt: string; productName: string; qty: number;
    customer: Customer; status: BookingStatus;
    readiness: { paid: boolean; signed: boolean; checklistDone: number; checklistTotal: number };
  }[];
  attention: {
    id: string; bookingId: string; ref: string; customer: Customer;
    kind: string; label: string; severity: "warning" | "critical"; at: string;
  }[];
  summary: { pickups: number; returns: number; classes: number; onRent: number; needsAttention: number };
}

export interface Settings {
  currency: string;
  navBaseUrl: string;
  navMode: "mock" | "live";
  navUsername: string;
  navDomain: string;
  shopifyShop: string;
  conduitUrl: string;
  posStoreId: string;
  posTerminalId: string;
  posStaffId: string;
  idRetentionDays: string;
  dataRetentionDays: string;
  publicUrl: string;
  contractTemplate: string;
  enabledLanguages: string;
  zoomAccountId: string;
  zoomClientId: string;
  zoomUserId: string;
  slotHoldMinutes?: string;
  maxCustomerReschedules?: string;
  reminderHours?: string;
  remindersEnabled?: string;
  reminderPickupEnabled?: string;
  reminderReturnEnabled?: string;
  reminderPickupHours?: string;
  reminderReturnHours?: string;
  reminderPickupSubject?: string;
  reminderPickupTemplate?: string;
  reminderReturnSubject?: string;
  reminderReturnTemplate?: string;
  cancelPolicyEnabled?: string;
  cancelFullRefundDays?: string;
  cancelPartialRefundDays?: string;
  cancelPartialRefundPercent?: string;
  pickupEarliestTime?: string;
  returnByTime?: string;
  rentalIncrementUnit?: "day" | "hour";
  rentalIncrementValue?: string;
  extensionsEnabled?: string;
  extensionApproval?: string;
  noShowFeeMode?: "off" | "percent" | "fixed";
  noShowFeeValue?: string;
  termsRentalEnabled?: string;
  termsCourseEnabled?: string;
  termsServiceEnabled?: string;
  termsRentalHtml?: string;
  termsCourseHtml?: string;
  termsServiceHtml?: string;
  termsRentalPdf?: string;
  termsCoursePdf?: string;
  termsServicePdf?: string;
  sftpHost?: string;
  sftpPort?: string;
  sftpUser?: string;
  sftpPath?: string;
  /** Write-only: accepted on PUT, never returned by GET. */
  navPassword?: string;
  shopifyApiSecret?: string;
  zoomClientSecret?: string;
  adminPassword?: string;
  sftpPassword?: string;
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
    // 401s from the staff-gated API relock the app; platform-admin endpoints
    // handle their own auth (a plain staff user legitimately gets 401 there).
    if (
      res.status === 401 &&
      !path.startsWith("/api/login") &&
      !path.startsWith("/api/auth") &&
      !path.startsWith("/api/admin/")
    ) {
      window.dispatchEvent(new Event("bd:unauthorized"));
    }
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

/**
 * Safely copy text to clipboard, handling insecure origins where navigator.clipboard is unavailable.
 * Returns true on success, false on failure (never throws).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
