// NAV / LS Central integration (LS Activity + WebPOS codeunits).
//
// SOAP envelopes mirror packages/connectors/src/infra/nav (the Gosselin middleware
// connector) so both codebases speak to the same web services — see
// Gosselin_Web_Services.pdf §"WS LS Activity" and §"WebPOS".
//
// navMode=mock (default without credentials) answers locally so the whole app runs
// end-to-end in dev; navMode=live sends NTLM-authenticated SOAP to NAV.
import { NtlmClient } from "axios-ntlm";
import type { AxiosInstance } from "axios";
import { XMLParser } from "fast-xml-parser";
import crypto from "node:crypto";
import { getSettings } from "../db.js";

const ENDPOINT = { ACTIVITY: "/Codeunit/WSLSActivity", WEBPOS: "/Codeunit/WSWebPOS" };
const ACTION = {
  GET_ACTIVITY_TYPE: "urn:microsoft-dynamics-schemas/codeunit/WSLSActivity:GetActivityType",
  GET_ACTIVITY_PRODUCTS: "urn:microsoft-dynamics-schemas/codeunit/WSLSActivity:GetActivityProducts",
  GET_ACTIVITY_AVAILABILITY: "urn:microsoft-dynamics-schemas/codeunit/WSLSActivity:GetActivityAvailability",
  CONFIRM_RESERVATION: "urn:microsoft-dynamics-schemas/codeunit/WSLSActivity:ActivityConfirmReservation",
  CANCEL_RESERVATION: "urn:microsoft-dynamics-schemas/codeunit/WSLSActivity:ActivityCancelReservation",
  WEBPOS_POST: "urn:microsoft-dynamics-schemas/codeunit/WSWebPOS:WebPosPost",
};

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

export function navMode(): "mock" | "live" {
  const s = getSettings();
  return s.navMode === "live" && s.navBaseUrl ? "live" : "mock";
}

function client(): AxiosInstance {
  const s = getSettings();
  // axios-ntlm is CJS; under NodeNext its AxiosInstance type is the CJS flavor while
  // ours is the ESM one — identical at runtime, so bridge the two with a cast.
  return NtlmClient(
    { username: s.navUsername, password: s.navPassword, domain: s.navDomain } as any,
    { baseURL: s.navBaseUrl, timeout: 60_000, headers: { "Content-Type": "application/xml" } } as any,
  ) as unknown as AxiosInstance;
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function soap(endpoint: string, action: string, body: string): Promise<any> {
  const envelope = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
      xmlns:ws="urn:microsoft-dynamics-schemas/codeunit/WSLSActivity"
      xmlns:tns="urn:microsoft-dynamics-schemas/codeunit/WSWebPOS">
      <soapenv:Header/>
      <soapenv:Body>${body}</soapenv:Body>
    </soapenv:Envelope>`.trim();
  const res = await client().post(endpoint, envelope, { headers: { SOAPAction: action } });
  const parsed = parser.parse(String(res.data));
  const resp = parsed?.Envelope?.Body;
  const code = JSON.stringify(resp ?? {});
  // NAV signals processing errors via pResponseCode 1800 + pErrorText (see spec p.14)
  if (code.includes('"pResponseCode":"1800"') || code.includes('"pResponseCode":1800')) {
    throw new Error(`NAV LS Activity error: ${extractFirst(resp, "pErrorText") || "unknown"}`);
  }
  return resp;
}

function extractFirst(obj: any, key: string): any {
  if (obj == null || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = extractFirst(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------------------
// Catalog pull: GetActivityType + GetActivityProducts
// ---------------------------------------------------------------------------

export interface NavActivityProduct {
  ProductNo: string;
  Description: string;
  DescriptionEn: string;
  ActivityType: string;
  DefaultQty: number;
  MinQty: number;
  MaxQty: number;
  DefaultUnitPrice: number;
  ProductType: string;
  FixedLocation: string;
  RetailItem: string;
  SecurityDeposit: number;
  AvailableOnWeb: string;
  WebDescEN: string;
  WebDescFR: string;
  DurationType: string;
  Duration: number;
  ActivityScheduling: { AvailabilityDate: string; AvailabilityTime: string; Location: string; Capacity: number; TeacherName: string }[];
  ActivityProductPrice: { Description: string; Price: number }[];
}

export async function getActivityTypes(): Promise<{ ActivityCode: string; Description: string }[]> {
  if (navMode() === "mock") return [{ ActivityCode: "RENTAL", Description: "Location d'équipement" }, { ActivityCode: "COURSE", Description: "Formations" }];
  const resp = await soap(
    ENDPOINT.ACTIVITY, ACTION.GET_ACTIVITY_TYPE,
    `<ws:GetActivityType><ws:pResponseCode></ws:pResponseCode><ws:pErrorText></ws:pErrorText>
     <ws:pWSActivityTypes><RootActivityType/></ws:pWSActivityTypes></ws:GetActivityType>`,
  );
  return asArray(extractFirst(resp, "ActivityTypes"));
}

export async function getActivityProducts(activityType: string): Promise<NavActivityProduct[]> {
  if (navMode() === "mock") return [];
  const resp = await soap(
    ENDPOINT.ACTIVITY, ACTION.GET_ACTIVITY_PRODUCTS,
    `<ws:GetActivityProducts><ws:pActivityType>${esc(activityType)}</ws:pActivityType>
     <ws:pResponseCode></ws:pResponseCode><ws:pErrorText></ws:pErrorText>
     <ws:pWSActivityProducts><RootActivityProducts/></ws:pWSActivityProducts></ws:GetActivityProducts>`,
  );
  return asArray<any>(extractFirst(resp, "ActivityProducts")).map((p: any) => ({
    ...p,
    ActivityScheduling: asArray(p.ActivityScheduling),
    ActivityProductPrice: asArray(p.ActivityProductPrice),
  }));
}

/** Availability straight from NAV (live mode); date format YYYY/MM/DD per spec. */
export async function getActivityAvailability(productNo: string, fromDate: string, noOfDays: number) {
  if (navMode() === "mock") return [];
  const navDate = fromDate.slice(0, 10).replace(/-/g, "/");
  const resp = await soap(
    ENDPOINT.ACTIVITY, ACTION.GET_ACTIVITY_AVAILABILITY,
    `<ws:GetActivityAvailability><ws:pProductNo>${esc(productNo)}</ws:pProductNo>
     <ws:pActivityDate>${esc(navDate)}</ws:pActivityDate><ws:pNoofDays>${noOfDays}</ws:pNoofDays>
     <ws:pResponseCode></ws:pResponseCode><ws:pErrorText></ws:pErrorText>
     <ws:pWSLSActivityAvailability><RootActivityAvailability/></ws:pWSLSActivityAvailability></ws:GetActivityAvailability>`,
  );
  return asArray<any>(extractFirst(resp, "AvailabilityWork"));
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export interface NavReservation {
  activityNo: string;
  sellingItem: string;
  unitPrice: number;
  lineDiscount: number;
  totalAmount: number;
  currency: string;
  bookingRef: string;
}

export async function confirmReservation(input: {
  locationNo: string; productNo: string;
  dateFrom: string; timeFrom: string; dateTo: string; timeTo: string; // dateTo/timeTo only for rentals
  clientId: string; quantity: number;
}): Promise<NavReservation> {
  if (navMode() === "mock") {
    const n = crypto.randomBytes(3).toString("hex").toUpperCase();
    return { activityNo: `ACT${n}`, sellingItem: "LS-ACTIVITY", unitPrice: 0, lineDiscount: 0, totalAmount: 0, currency: "CAD", bookingRef: `LSA-${n}` };
  }
  const resp = await soap(
    ENDPOINT.ACTIVITY, ACTION.CONFIRM_RESERVATION,
    `<ws:ActivityConfirmReservation>
      <ws:pLocationNo>${esc(input.locationNo)}</ws:pLocationNo>
      <ws:pProductNo>${esc(input.productNo)}</ws:pProductNo>
      <ws:pActivityDate>${esc(input.dateFrom)}</ws:pActivityDate>
      <ws:pActivityTime>${esc(input.timeFrom)}</ws:pActivityTime>
      <ws:pActivityDateTo>${esc(input.dateTo)}</ws:pActivityDateTo>
      <ws:pActivityTimeTo>${esc(input.timeTo)}</ws:pActivityTimeTo>
      <ws:pClientID>${esc(input.clientId)}</ws:pClientID>
      <ws:pQuantity>${input.quantity}</ws:pQuantity>
      <ws:pWebPageLink></ws:pWebPageLink>
      <ws:pReturnActivityNo></ws:pReturnActivityNo><ws:pReturnSellingItem></ws:pReturnSellingItem>
      <ws:pReturnUnitPrice>0</ws:pReturnUnitPrice><ws:pReturnLineDiscount>0</ws:pReturnLineDiscount>
      <ws:pReturnTotalAmount>0</ws:pReturnTotalAmount><ws:pReturnCurrency></ws:pReturnCurrency>
      <ws:pReturnBookingRef></ws:pReturnBookingRef>
      <ws:pResponseCode></ws:pResponseCode><ws:pErrorText></ws:pErrorText>
    </ws:ActivityConfirmReservation>`,
  );
  return {
    activityNo: String(extractFirst(resp, "pReturnActivityNo") ?? ""),
    sellingItem: String(extractFirst(resp, "pReturnSellingItem") ?? ""),
    unitPrice: Number(extractFirst(resp, "pReturnUnitPrice") ?? 0),
    lineDiscount: Number(extractFirst(resp, "pReturnLineDiscount") ?? 0),
    totalAmount: Number(extractFirst(resp, "pReturnTotalAmount") ?? 0),
    currency: String(extractFirst(resp, "pReturnCurrency") ?? "CAD"),
    bookingRef: String(extractFirst(resp, "pReturnBookingRef") ?? ""),
  };
}

export async function cancelReservation(activityNo: string, clientNo: string): Promise<boolean> {
  if (navMode() === "mock") return true;
  const resp = await soap(
    ENDPOINT.ACTIVITY, ACTION.CANCEL_RESERVATION,
    `<ws:ActivityCancelReservation>
      <ws:pActivityNo>${esc(activityNo)}</ws:pActivityNo>
      <ws:pClientNo>${esc(clientNo)}</ws:pClientNo>
      <ws:pErrorText></ws:pErrorText>
      <ws:pReturnProductNo></ws:pReturnProductNo><ws:pReturnUnitPrice>0</ws:pReturnUnitPrice>
      <ws:pReturnQty>0</ws:pReturnQty><ws:pReturnLineDiscount>0</ws:pReturnLineDiscount>
      <ws:pReturnTotalAmount>0</ws:pReturnTotalAmount><ws:pReturnCurrency></ws:pReturnCurrency>
      <ws:pReturnBookingRef></ws:pReturnBookingRef>
    </ws:ActivityCancelReservation>`,
  );
  return String(extractFirst(resp, "return_value")) === "true";
}

// ---------------------------------------------------------------------------
// WebPOS: push a booking to LS Retail POS as a SUSPENDED transaction (R3B / class step 12-15).
// The POS retrieves it, applies coupons/tenders, and posting the FreeText line whose
// barcode = NAV BookingRef marks the reservation paid (spec: Send Activity Reservation notes).
// ---------------------------------------------------------------------------

export interface PosLine { sellingItem: string; description: string; amount: number; bookingRef: string; qty: number }

export async function webPosSuspend(input: {
  receiptNo: string; customerEmail: string; lines: PosLine[];
}): Promise<{ receiptNo: string }> {
  if (navMode() === "mock") return { receiptNo: input.receiptNo };
  const s = getSettings();
  const guid = "00000000-0000-0000-0000-000000000000";
  const head =
    `<q3:MobileTransaction><q3:Id>${guid}</q3:Id><q3:StoreId>${esc(s.posStoreId)}</q3:StoreId>` +
    `<q3:TerminalId>${esc(s.posTerminalId)}</q3:TerminalId><q3:StaffId>${esc(s.posStaffId)}</q3:StaffId>` +
    `<q3:TransactionType>2</q3:TransactionType><q3:EntryStatus>2</q3:EntryStatus>` +
    `<q3:ReceiptNo>${esc(input.receiptNo)}</q3:ReceiptNo><q3:TransDate>${new Date().toISOString()}</q3:TransDate>` +
    `<q3:CustomerEmail>${esc(input.customerEmail)}</q3:CustomerEmail><q3:ForceUnbalanceTransaction>false</q3:ForceUnbalanceTransaction></q3:MobileTransaction>`;
  const lines = input.lines
    .map((l, i) => {
      const itemLineNo = (i * 2 + 1) * 10000;
      // Item line with the activity selling item at NAV's returned amount (manual price)…
      const item =
        `<q3:MobileTransactionLine><q3:Id>${guid}</q3:Id><q3:StoreId>${esc(s.posStoreId)}</q3:StoreId>` +
        `<q3:TerminalId>${esc(s.posTerminalId)}</q3:TerminalId><q3:LineNo>${itemLineNo}</q3:LineNo>` +
        `<q3:LineType>0</q3:LineType><q3:Number>${esc(l.sellingItem)}</q3:Number>` +
        `<q3:Quantity>${l.qty}</q3:Quantity><q3:ManualPrice>${l.amount}</q3:ManualPrice></q3:MobileTransactionLine>`;
      // …plus the FreeText line carrying the BookingRef barcode (payment trigger on posting).
      const freeText =
        `<q3:MobileTransactionLine><q3:Id>${guid}</q3:Id><q3:StoreId>${esc(s.posStoreId)}</q3:StoreId>` +
        `<q3:TerminalId>${esc(s.posTerminalId)}</q3:TerminalId><q3:LineNo>${itemLineNo + 10000}</q3:LineNo>` +
        `<q3:LineType>5</q3:LineType><q3:Barcode>${esc(l.bookingRef)}</q3:Barcode>` +
        `<q3:ItemDescription>${esc(l.description)}</q3:ItemDescription></q3:MobileTransactionLine>`;
      return item + freeText;
    })
    .join("");
  const order =
    `<q3:MobileTransactionOrder><q3:Id>${guid}</q3:Id><q3:StoreId>${esc(s.posStoreId)}</q3:StoreId>` +
    `<q3:TerminalId>${esc(s.posTerminalId)}</q3:TerminalId><q3:ReceiptNo>${esc(input.receiptNo)}</q3:ReceiptNo>` +
    `<q3:OrderNo>${esc(input.receiptNo)}</q3:OrderNo><q3:BillingEmail>${esc(input.customerEmail)}</q3:BillingEmail></q3:MobileTransactionOrder>`;
  await soap(
    ENDPOINT.WEBPOS, ACTION.WEBPOS_POST,
    `<tns:WebPosPost><tns:pResponseCode></tns:pResponseCode><tns:pErrorText></tns:pErrorText>
     <tns:pWSMobileTransactionXML xmlns:q3="urn:microsoft-dynamics-nav/xmlports/x99009320">${head}${lines}${order}</tns:pWSMobileTransactionXML></tns:WebPosPost>`,
  );
  return { receiptNo: input.receiptNo };
}
