// FULL REPLACEMENT MCP SERVER HANDLER (AUTO TOKEN REFRESH)
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

let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

function getEbayBaseUrl() {
  return String(process.env.EBAY_ENV || "production").toLowerCase() === "sandbox"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

function getMarketplaceId() {
  return process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
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

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const tokenUrl = `${getEbayBaseUrl()}/identity/v1/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    // Typical scope for Browse API search. If your app uses different scopes,
    // adjust accordingly to what your eBay app is approved for.
    scope: "https://api.ebay.com/oauth/api_scope",
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
      `eBay token refresh failed (${resp.status}): ${JSON.stringify(json)}`
    );
  }

  const token = json?.access_token;
  const expiresInSec = Number(json?.expires_in || 0);

  if (!token || !expiresInSec) {
    throw new Error(`eBay token refresh returned unexpected payload: ${JSON.stringify(json)}`);
  }

  cachedToken = token;
  cachedTokenExpiresAt = Date.now() + expiresInSec * 1000;

  return cachedToken;
}

function mcpOk(id, payloadArray) {
  return {
    jsonrpc: "2.0",
    id: id ?? 1,
    result: { content: [{ type: "text", text: JSON.stringify(payloadArray || []) }] },
  };
}

function mcpErr(id, message, status = 500) {
  return {
    status,
    body: {
      jsonrpc: "2.0",
      id: id ?? 1,
      error: { message: message || "Server error" },
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

    // eBay Browse API sort mapping:
    // - default best match: omit sort params
    // - ending soon: sort=endingSoonest
    // - price: sort=price with sortOrder ASC/DESC
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
      },
    });

    const text = await r.text();

    if (!r.ok) {
      res.status(r.status).json({
        jsonrpc: "2.0",
        id,
        error: { message: `eBay error (${r.status}): ${text}` },
      });
      return;
    }

    const data = JSON.parse(text);
    const items = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];

    const simplified = items.map((it) => {
      const priceVal = Number(it?.price?.value ?? 0);

      // shippingOptions is often missing; be defensive
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




