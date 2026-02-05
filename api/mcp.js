// FULL REPLACEMENT MCP SERVER HANDLER (AUTO TOKEN REFRESH + EDGE SAFE)
// Supports: query, limit, offset, sort
// sort: BEST_MATCH | PRICE_DESC | PRICE_ASC | ENDING_SOON
//
// Required env vars (Vercel):
// - EBAY_CLIENT_ID
// - EBAY_CLIENT_SECRET
// - EBAY_REFRESH_TOKEN
//
// Optional env vars:
// - EBAY_ENV = "production" | "sandbox" (default "production")
// - EBAY_MARKETPLACE_ID = "EBAY_US" (default "EBAY_US")
// - EBAY_OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope" (default shown)

let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

function getEbayEnv() {
  return String(process.env.EBAY_ENV || "production").toLowerCase() === "sandbox"
    ? "sandbox"
    : "production";
}

function getEbayBaseUrl() {
  return getEbayEnv() === "sandbox"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

function getMarketplaceId() {
  return process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
}

function getOauthScope() {
  // Allow override without code changes if eBay requires different scopes
  return process.env.EBAY_OAUTH_SCOPE || "https://api.ebay.com/oauth/api_scope";
}

// Edge-safe base64 (Buffer may not exist on edge)
function toBase64(str) {
  try {
    // Node
    if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64");
  } catch {}
  // Edge / Browser-like
  if (typeof btoa !== "undefined") return btoa(str);

  // Last resort: manual encoding
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

async function getEbayAccessToken() {
  const now = Date.now();
  // 60s safety buffer
  if (cachedToken && cachedTokenExpiresAt - now > 60_000) return cachedToken;

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing eBay env vars. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN."
    );
  }

  const basic = toBase64(`${clientId}:${clientSecret}`);
  const tokenUrl = `${getEbayBaseUrl()}/identity/v1/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: getOauthScope(),
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    throw new Error(
      `eBay token refresh failed (${resp.status}) [env=${getEbayEnv()} scope=${getOauthScope()}]: ${JSON.stringify(
        json
      )}`
    );
  }

  const token = json?.access_token;
  const expiresInSec = Number(json?.expires_in || 0);

  if (!token || !expiresInSec) {
    throw new Error(
      `eBay token refresh returned unexpected payload: ${JSON.stringify(json)}`
    );
  }

  cachedToken = token;
  cachedTokenExpiresAt = Date.now() + expiresInSec * 1000;

  return cachedToken;
}

function mcpOk(id, payloadArray) {
  return {
    jsonrpc: "2.0",
    id: id ?? 1,
    result: {
      content: [
        { type: "text", text: JSON.stringify(payloadArray || []) },
      ],
    },
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = req.body || {};
    const id = body?.id ?? 1;

    const method = body?.method;
    const toolName = body?.params?.name;
    const args = body?.params?.arguments || {};

    if (method !== "tools/call" || toolName !== "search_ebay") {
      res.status(400).json({
        jsonrpc: "2.0",
        id,
        error: { message: "Unsupported method/tool" },
      });
      return;
    }

    const query = String(args?.query || "").trim();
    const limitRaw = Number(args?.limit ?? 50);
    const offsetRaw = Number(args?.offset ?? 0);
    const sort = String(args?.sort || "BEST_MATCH").toUpperCase();

    if (!query) {
      res.status(200).json(mcpOk(id, []));
      return;
    }

    const limit = Math.min(Math.max(limitRaw, 1), 200);
    const offset = Math.max(offsetRaw, 0);

    let ebaySort = null;
    let ebaySortOrder = null;

    if (sort === "ENDING_SOON") {
      ebaySort = "endingSoonest";
    } else if (sort === "PRICE_DESC") {
      ebaySort = "price";
      ebaySortOrder = "DESC";
    } else if (sort === "PRICE_ASC") {
      ebaySort = "price";
      ebaySortOrder = "ASC";
    }

    const params = new URLSearchParams();
    params.set("q", query);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (ebaySort) params.set("sort", ebaySort);
    if (ebaySortOrder) params.set("sortOrder", ebaySortOrder);

    const url = `${getEbayBaseUrl()}/buy/browse/v1/item_summary/search?${params.toString()}`;

    const token = await getEbayAccessToken();

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        // This can improve consistency for some marketplaces
        "Content-Language": "en-US",
      },
    });

    const text = await r.text();

    if (!r.ok) {
      res.status(r.status).json({
        jsonrpc: "2.0",
        id,
        error: {
          message: `eBay error (${r.status}) [env=${getEbayEnv()} marketplace=${getMarketplaceId()}]: ${text}`,
        },
      });
      return;
    }

    const data = JSON.parse(text);
    const items = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];

    const simplified = items.map((it) => {
      const priceVal = Number(it?.price?.value ?? 0);
      const shippingVal = Number(
        it?.shippingOptions?.[0]?.shippingCost?.value ??
          it?.shippingOptions?.[0]?.shippingCost?.convertedFromValue ??
          0
      );

      return {
        id: it?.itemId || null,
        itemId: it?.itemId || null,
        title: it?.title || "",
        price: priceVal,
        shipping: shippingVal,
        itemWebUrl: it?.itemWebUrl || null,
        image: { imageUrl: it?.image?.imageUrl || null },
        seller: it?.seller?.username || "eBay Seller",
        sellerFeedbackPercentage: it?.seller?.feedbackPercentage ?? 99,
        itemEndDate: it?.itemEndDate || null,
        buyingOptions: it?.buyingOptions || [],
      };
    });

    res.status(200).json(mcpOk(id, simplified));
  } catch (e) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: 1,
      error: { message: e?.message || String(e) },
    });
  }
}





