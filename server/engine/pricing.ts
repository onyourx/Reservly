// Rental pricing (requirement R3A): billed in whole days — any rental up to 24h is
// 1 day, 25h is 2 days, etc. A WEEKLY price tier (from NAV ActivityProductPrice) is
// applied per full 7-day block when it beats 7× the daily rate.
import { db } from "../db.js";

export interface ProductRow {
  id: string; product_no: string; type: string; name: string;
  default_unit_price: number; security_deposit: number; retail_item: string;
  min_qty: number; max_qty: number;
}

export function productByNo(productNo: string): ProductRow | undefined {
  return db.prepare("SELECT * FROM products WHERE product_no = ?").get(productNo) as ProductRow | undefined;
}

export function rentalDays(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

export function weeklyPrice(productId: string): number | null {
  const row = db
    .prepare("SELECT price FROM product_prices WHERE product_id = ? AND UPPER(description) LIKE '%WEEK%' ORDER BY price LIMIT 1")
    .get(productId) as { price: number } | undefined;
  return row?.price ?? null;
}

export function rentalLineTotal(product: ProductRow, days: number, qty: number): { unitPrice: number; lineTotal: number } {
  const daily = product.default_unit_price;
  const weekly = weeklyPrice(product.id);
  let perUnit = daily * days;
  if (weekly != null && days >= 7) {
    const weeks = Math.floor(days / 7);
    const rem = days % 7;
    perUnit = Math.min(perUnit, weeks * weekly + Math.min(rem * daily, weekly));
  }
  return { unitPrice: round2(perUnit), lineTotal: round2(perUnit * qty) };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export interface QuoteLineIn {
  type: "RENTAL" | "COURSE";
  productNo?: string;
  storeId?: string;
  from?: string;
  to?: string;
  sessionId?: string;
  qty: number;
}

export interface QuotedLine extends QuoteLineIn {
  productNo: string;
  productName: string;
  days?: number;
  unitPrice: number;
  lineTotal: number;
  deposit: number;
  from: string;
  to: string;
}

export function quoteLines(lines: QuoteLineIn[]): { lines: QuotedLine[]; subtotal: number; deposit: number } {
  const out: QuotedLine[] = [];
  for (const line of lines) {
    const qty = Math.max(1, Number(line.qty) || 1);
    if (line.type === "RENTAL") {
      if (!line.productNo || !line.from || !line.to) throw new Error("Rental line needs productNo, from, to");
      const product = productByNo(line.productNo);
      if (!product) throw new Error(`Unknown product ${line.productNo}`);
      const days = rentalDays(line.from, line.to);
      const { unitPrice, lineTotal } = rentalLineTotal(product, days, qty);
      out.push({
        ...line, qty, productNo: product.product_no, productName: product.name, days,
        unitPrice, lineTotal, deposit: round2(product.security_deposit * qty),
        from: line.from, to: line.to,
      });
    } else {
      if (!line.sessionId) throw new Error("Course line needs sessionId");
      const session = db
        .prepare(
          `SELECT s.*, p.product_no, p.name, p.default_unit_price FROM sessions s
           JOIN products p ON p.id = s.product_id WHERE s.id = ?`,
        )
        .get(line.sessionId) as any;
      if (!session) throw new Error(`Unknown session ${line.sessionId}`);
      out.push({
        ...line, qty, productNo: session.product_no, productName: session.name,
        unitPrice: session.default_unit_price, lineTotal: round2(session.default_unit_price * qty),
        deposit: 0, from: session.starts_at, to: session.ends_at, storeId: session.store_id,
      });
    }
  }
  return {
    lines: out,
    subtotal: round2(out.reduce((a, l) => a + l.lineTotal, 0)),
    deposit: round2(out.reduce((a, l) => a + l.deposit, 0)),
  };
}
