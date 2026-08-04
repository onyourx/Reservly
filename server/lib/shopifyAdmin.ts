// Shopify Admin API client using the client-credentials grant (valid because
// Bagsy is our own org's app installed on our own store): the server exchanges
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
const customerEmailCache = new Map<string, { email: string; expiresAt: number }>();
const CUSTOMER_EMAIL_CACHE_TTL_MS = 10 * 60 * 1000;

async function getToken(): Promise<{ shop: string; token: string }> {
  const s = getSettings();
  const shop = s.shopifyShop.trim().toLowerCase();
  if (!shop) throw new Error("Set 'Shopify shop' in Settings first (e.g. your-store.myshopify.com)");
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

/** Resolve a Shopify customer ID to an email without allowing Admin API
 * configuration or availability issues to break storefront requests. */
export async function getShopifyCustomerEmail(customerId: string): Promise<string | null> {
  const id = String(customerId ?? "").trim();
  if (!id) return null;

  const cached = customerEmailCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.email;
  if (cached) customerEmailCache.delete(id);

  try {
    const data = await shopifyGql<{ customer: { email: string | null } | null }>(
      `query($id: ID!) {
        customer(id: $id) { email }
      }`,
      { id: `gid://shopify/Customer/${id}` },
    );
    const email = data.customer?.email?.trim();
    if (!email) return null;

    const now = Date.now();
    for (const [key, entry] of customerEmailCache) {
      if (entry.expiresAt <= now) customerEmailCache.delete(key);
    }
    customerEmailCache.set(id, { email, expiresAt: now + CUSTOMER_EMAIL_CACHE_TTL_MS });
    return email;
  } catch {
    return null;
  }
}

/** Create the product metafield definitions the booking widget reads
 *  (booking.type / booking.product_no). Idempotent: 'taken' errors are fine. */
export async function ensureMetafieldDefinitions(): Promise<string[]> {
  const defs = [
    { name: "Booking type", namespace: "booking", key: "type", description: "RENTAL or COURSE — read by the Bagsy booking widget" },
    { name: "Booking product no", namespace: "booking", key: "product_no", description: "NAV LS Activity ProductNo — read by the Bagsy booking widget" },
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

export async function findShopifyCustomer(email: string): Promise<{ id: string; email: string; firstName: string; lastName: string; phone: string } | null> {
  const data = await shopifyGql<{ customers: { nodes: { id: string; email: string; firstName: string; lastName: string; phone: string }[] } }>(
    `query($q: String!) {
      customers(first: 1, query: $q) {
        nodes { id email firstName lastName phone }
      }
    }`,
    { q: `email:"${email}"` },
  );
  return data.customers.nodes[0] ?? null;
}

export async function ensureShopifyCustomer(c: { email: string; firstName?: string; lastName?: string; phone?: string }): Promise<string | null> {
  const existing = await findShopifyCustomer(c.email);
  if (existing) return existing.id;

  const input: { email: string; firstName?: string; lastName?: string; phone?: string } = { email: c.email };
  if (c.firstName?.trim()) input.firstName = c.firstName;
  if (c.lastName?.trim()) input.lastName = c.lastName;
  if (c.phone?.trim()) input.phone = c.phone;

  const data = await shopifyGql<{ customerCreate: { customer: { id: string } | null; userErrors: { message: string }[] } }>(
    `mutation($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id }
        userErrors { message }
      }
    }`,
    { input },
  );
  const errs = data.customerCreate.userErrors ?? [];
  if (errs.length) throw new Error(`customerCreate: ${errs.map((e) => e.message).join("; ")}`);
  if (!data.customerCreate.customer?.id) throw new Error("customerCreate: no customer returned");
  return data.customerCreate.customer.id;
}

export async function createDraftInvoice(params: {
  customerId?: string;
  customerEmail: string;
  customerFirstName?: string;
  customerLastName?: string;
  customerPhone?: string;
  title: string;
  price: number;
  customAttributes: Array<{ key: string; value: string }>;
}): Promise<{ draftOrderId: string; invoiceUrl: string } | null> {
  try {
    const customerId = params.customerId || await ensureShopifyCustomer({
      email: params.customerEmail,
      firstName: params.customerFirstName,
      lastName: params.customerLastName,
      phone: params.customerPhone,
    });
    if (!customerId) throw new Error("Shopify customer could not be resolved");

    const created = await shopifyGql<{
      draftOrderCreate: {
        draftOrder: { id: string; invoiceUrl: string } | null;
        userErrors: { message: string }[];
      };
    }>(
      `mutation($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl }
          userErrors { message }
        }
      }`,
      { input: {
        customerId,
        lineItems: [{ title: params.title, quantity: 1, price: String(params.price) }],
        customAttributes: params.customAttributes,
      } },
    );
    const createErrors = created.draftOrderCreate.userErrors ?? [];
    if (createErrors.length) throw new Error(`draftOrderCreate: ${createErrors.map((error) => error.message).join("; ")}`);
    const draftOrderId = created.draftOrderCreate.draftOrder?.id;
    if (!draftOrderId) throw new Error("draftOrderCreate returned no draft order");

    const sent = await shopifyGql<{
      draftOrderInvoiceSend: {
        draftOrder: { invoiceUrl: string } | null;
        userErrors: { message: string }[];
      };
    }>(
      `mutation($draftOrderId: ID!) {
        draftOrderInvoiceSend(draftOrderId: $draftOrderId) {
          draftOrder { invoiceUrl }
          userErrors { message }
        }
      }`,
      { draftOrderId },
    );
    const sendErrors = sent.draftOrderInvoiceSend.userErrors ?? [];
    if (sendErrors.length) throw new Error(`draftOrderInvoiceSend: ${sendErrors.map((error) => error.message).join("; ")}`);
    return {
      draftOrderId,
      invoiceUrl: sent.draftOrderInvoiceSend.draftOrder?.invoiceUrl
        || created.draftOrderCreate.draftOrder?.invoiceUrl
        || "",
    };
  } catch (err) {
    console.error("[shopify] createDraftInvoice failed:", err);
    return null;
  }
}

/** Sales-channel publications, cached per process (they rarely change). */
let publicationsCache: { id: string; name: string }[] | null = null;

export async function getPublications(): Promise<{ id: string; name: string }[]> {
  if (publicationsCache) return publicationsCache;
  const d = await shopifyGql<{ publications: { nodes: { id: string; name: string }[] } }>(
    `{ publications(first: 20) { nodes { id name } } }`,
  );
  publicationsCache = d.publications.nodes;
  return publicationsCache;
}

/** Publish a product to the requested sales channels (Online Store / Point of Sale). */
export async function publishToChannels(
  productGid: string,
  channels: { onlineStore?: boolean; pos?: boolean },
): Promise<string[]> {
  const pubs = await getPublications();
  const wanted = pubs.filter(
    (p) =>
      (channels.onlineStore && p.name === "Online Store") ||
      (channels.pos && p.name === "Point of Sale"),
  );
  if (!wanted.length) return [];
  const d = await shopifyGql<{ publishablePublish: { userErrors: { message: string }[] } }>(
    `mutation($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { message } }
    }`,
    { id: productGid, input: wanted.map((p) => ({ publicationId: p.id })) },
  );
  const errs = d.publishablePublish.userErrors ?? [];
  if (errs.length) throw new Error(`publish to channels: ${errs.map((e) => e.message).join("; ")}`);
  return wanted.map((p) => p.name);
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
