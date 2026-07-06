// Shopify Admin API client using the client-credentials grant (valid because
// Reservly is our own org's app installed on our own store): the server exchanges
// client_id + client_secret for a 24h access token — no OAuth redirect dance.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_VERSION = "2025-07";

function clientId(): string {
  const fromSettings = getSettings().shopifyClientId;
  if (fromSettings) return fromSettings;
  // Fall back to the CLI-managed app config next to the server.
  try {
    const toml = fs.readFileSync(path.join(__dirname, "..", "..", "shopify.app.toml"), "utf8");
    return /client_id\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? "";
  } catch {
    return "";
  }
}

let tokenCache: { token: string; shop: string; expiresAt: number } | null = null;

async function getToken(): Promise<{ shop: string; token: string }> {
  const s = getSettings();
  const shop = s.shopifyShop.trim().toLowerCase();
  if (!shop) throw new Error("Set 'Shopify shop' in Settings first (e.g. reservly.myshopify.com)");
  if (!s.shopifyApiSecret) throw new Error("Set 'Shopify API secret' in Settings first");
  const id = clientId();
  if (!id) throw new Error("No Shopify client_id found (shopify.app.toml or Settings)");

  if (tokenCache && tokenCache.shop === shop && tokenCache.expiresAt > Date.now() + 60_000) {
    return { shop, token: tokenCache.token };
  }
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: s.shopifyApiSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify token request failed (HTTP ${res.status}) — is the app installed on ${shop}? ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache = { shop, token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 86399) - 300) * 1000 };
  return { shop, token: data.access_token };
}

export async function shopifyGql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { shop, token } = await getToken();
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`}`);
  }
  return body.data as T;
}

/** Create the product metafield definitions the booking widget reads
 *  (booking.type / booking.product_no). Idempotent: 'taken' errors are fine. */
export async function ensureMetafieldDefinitions(): Promise<string[]> {
  const defs = [
    { name: "Booking type", namespace: "booking", key: "type", description: "RENTAL or COURSE — read by the Reservly booking widget" },
    { name: "Booking product no", namespace: "booking", key: "product_no", description: "NAV LS Activity ProductNo — read by the Reservly booking widget" },
  ];
  const results: string[] = [];
  for (const def of defs) {
    const data = await shopifyGql<{ metafieldDefinitionCreate: { createdDefinition: { id: string } | null; userErrors: { code: string; message: string }[] } }>(
      `mutation($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { code message }
        }
      }`,
      { definition: { ...def, ownerType: "PRODUCT", type: "single_line_text_field" } },
    );
    const errs = data.metafieldDefinitionCreate.userErrors ?? [];
    if (data.metafieldDefinitionCreate.createdDefinition) results.push(`${def.namespace}.${def.key}: created`);
    else if (errs.some((e) => e.code === "TAKEN")) results.push(`${def.namespace}.${def.key}: already exists`);
    else if (errs.length) throw new Error(`metafield definition ${def.key}: ${errs.map((e) => e.message).join("; ")}`);
  }
  return results;
}

export interface PushableProduct {
  product_no: string; type: string; name: string; web_desc_en: string;
  default_unit_price: number; retail_item: string; image_url: string;
  shopify_product_id: string;
}

/** Create or update the Shopify product for a booking product (one call via
 *  productSet), including price, metafields and image. Returns the product GID. */
export async function pushProductToShopify(p: PushableProduct): Promise<{ id: string; handle: string }> {
  const input: Record<string, unknown> = {
    title: p.type === "RENTAL" ? `${p.name} — Rental` : p.name,
    descriptionHtml: p.web_desc_en || "",
    status: "ACTIVE",
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [{
      price: String(p.default_unit_price),
      sku: p.retail_item || p.product_no,
      optionValues: [{ optionName: "Title", name: "Default Title" }],
    }],
    metafields: [
      { namespace: "booking", key: "type", type: "single_line_text_field", value: p.type },
      { namespace: "booking", key: "product_no", type: "single_line_text_field", value: p.product_no },
    ],
  };
  if (p.shopify_product_id) input.id = p.shopify_product_id;
  if (p.image_url) input.files = [{ originalSource: p.image_url, contentType: "IMAGE" }];

  const data = await shopifyGql<{ productSet: { product: { id: string; handle: string } | null; userErrors: { field: string[]; message: string }[] } }>(
    `mutation($input: ProductSetInput!) {
      productSet(input: $input) {
        product { id handle }
        userErrors { field message }
      }
    }`,
    { input },
  );
  const errs = data.productSet.userErrors ?? [];
  if (!data.productSet.product) throw new Error(`productSet: ${errs.map((e) => e.message).join("; ") || "no product returned"}`);
  return data.productSet.product;
}
