export interface ChecklistItem {
  itemNo: string;
  description: string;
  qty: number;
  checked: boolean;
}

export interface Line {
  id: string;
  type: "RENTAL" | "COURSE";
  productNo: string;
  productName: string;
  from: string;
  to: string;
  qty: number;
  days?: number;
  lineTotal: number;
  checklist: ChecklistItem[];
}

export interface Booking {
  id: string;
  ref: string;
  type: string;
  status: string;
  storeId: string;
  customer: { email: string; firstName: string; lastName: string; phone: string; b2b: boolean };
  lines: Line[];
  subtotal: number;
  deposit: number;
  contractSignedAt: string | null;
  signatureName?: string;
  createdAt: string;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method: opts.method ?? (hasBody ? "POST" : "GET"),
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event("rsv:unauthorized"));
    throw new Error("Signed out");
  }
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) message = d.error;
    } catch {
      /* keep status */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const money = (n: number) => `CA$${(Number(n) || 0).toFixed(2)}`;
export const fmtDT = (s: string) =>
  s ? new Date(s).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
