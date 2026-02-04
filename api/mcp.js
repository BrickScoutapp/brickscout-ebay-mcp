/* api/mcp.js
 * Vercel Node Function (CommonJS)
 * - CORS enabled (prevents "Failed to fetch" from browser)
 * - OPTIONS preflight supported
 * - eBay Browse API search + enrichment via getItem
 */

const EBAY_ENV = (process.env.EBAY_ENV || "production").toLowerCase();

const EBAY_OAUTH =
  EBAY_ENV === "sandbox"
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";

const EBAY_BROWSE =
  EBAY_ENV === "sandbox"
    ? "https://api.sandbox.ebay.com/buy/browse/v1"
    : "https://api.ebay.com/buy/browse/v1";

const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

let tokenCache = { accessToken: null, expiresAtMs: 0 };

/* -------------------------
   CORS (IMPORTANT)
-------------------------- */
function setCors(res) {
  // If you want to lock this down later, replace "*" with your Base44 domain.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* -------------------------
   Helpers
-------------------------- */
function sendJson(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, message, code = -32000) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return null;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

/**
 * Browse API search ≠ ebay.com search
 * Remove "-keyword" tokens (your frontend adds these)
 */
function sanitizeBrowseQuery(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const tokens = s.split(/\s+/g);

  const cleaned = tokens.filter((t) => {
    if (!t) return false;
    if (t.startsWith("-")) return false; // KEY
    if (t === "OR" || t === "AND" || t === "NOT") return false;
    return true;
  });

  const out = cleaned.join(" ").trim();
  return out || s.replace(/-\S+/g, "").trim() || "";
}

/* -------------------------
   OAuth
-------------------------- */
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAtMs - 30000 > now) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  // Browse API scope
  const scope = "https://api.ebay.com/oauth/api_scope";

  const resp = await fetch(EBAY_OAUTH, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope,
    }).toString(),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OAuth failed ${resp.status}: ${t}`);
  }

  const data = await resp.json();
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAtMs = now + toNum(data.expires_in, 7200) * 1000;
  return tokenCache.accessToken;
}

/* -------------------------
   eBay Browse API
-------------------------- */
async function ebayFetch(path) {
  const token = await getAccessToken();

  const resp = await fetch(`${EBAY_BROWSE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    },
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`eBay API ${resp.status} ${path}: ${t}`);
  }

  return resp.json();
}

async function browseSearch({ query, limit }) {
  const lim = clampInt(limit, 1, 50, 25);
  const cleaned = sanitizeBrowseQuery(query);

  const params = new URLSearchParams({
    q: cleaned || "LEGO",
    limit: String(lim),
  });

  return ebayFetch(`/item_summary/search?${params.toString()}`);
}

async function browseGetItem(restId) {
  return ebayFetch(`/item/${encodeURIComponent(restId)}`);
}

/* -------------------------
   Concurrency helper
-------------------------- */
async function mapWithConcurrency(arr, concurrency, fn) {
  const out = new Array(arr.length);
  let idx = 0;

  async function worker() {
    while (idx < arr.length) {
      const i = idx++;
      out[i] = await fn(arr[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, arr.length) }, () => worker())
  );
  return out;
}

/* -------------------------
   Enriched search
   Returns shape your frontend already expects:
   { itemId, title, price, shipping, seller, sellerFeedbackPercent, itemWebUrl, image }
-------------------------- */
async function searchEbayEnriched({ query, limit }) {
  const search = await browseSearch({ query, limit });
  const summaries = Array.isArray(search?.itemSummaries)
    ? search.itemSummaries
    : [];

  const restIds = summaries.map((s) => s?.itemId).filter(Boolean);

  const details = await mapWithConcurrency(restIds, 5, async (rid) => {
    try {
      const d = await browseGetItem(rid);
      return { ok: true, rid, d };
    } catch (e) {
      return { ok: false, rid, error: String(e?.message || e) };
    }
  });

  const detailMap = new Map(
    details.filter((x) => x.ok && x.d).map((x) => [x.rid, x.d])
  );

  return summaries.map((s) => {
    const rid = s?.itemId || null;
    const d = rid ? detailMap.get(rid) : null;

    const legacyId = pickFirst(d?.legacyItemId, s?.legacyItemId, null);
    const title = pickFirst(d?.title, s?.title, "Untitled listing");

    const itemWebUrl = pickFirst(
      d?.itemWebUrl,
      s?.itemWebUrl,
      legacyId ? `https://www.ebay.com/itm/${legacyId}` : null,
      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(title)}`
    );

    const imageUrl = pickFirst(
      d?.image?.imageUrl,
      d?.primaryImage?.imageUrl,
      s?.image?.imageUrl,
      s?.thumbnailImage?.imageUrl,
      null
    );

    const price =
      toNum(d?.price?.value, NaN) || toNum(s?.price?.value, NaN) || 0;

    const shipping =
      toNum(d?.shippingOptions?.[0]?.shippingCost?.value, NaN) ||
      toNum(s?.shippingOptions?.[0]?.shippingCost?.value, NaN) ||
      0;

    const seller = pickFirst(
      d?.seller?.username,
      s?.seller?.username,
      "eBay Seller"
    );

    const sellerFeedbackPercent =
      toNum(d?.seller?.feedbackPercentage, NaN) ||
      toNum(s?.seller?.feedbackPercentage, NaN) ||
      99;

    return {
      itemId: legacyId || rid,
      title,
      price,
      shipping,
      seller,
      sellerFeedbackPercent,
      itemWebUrl,
      image: imageUrl || null,
      itemEndDate: pickFirst(d?.itemEndDate, s?.itemEndDate, null),
      buyingOptions: Array.isArray(s?.buyingOptions) ? s.buyingOptions : [],
    };
  });
}

/* -------------------------
   Vercel handler
-------------------------- */
module.exports = async function handler(req, res) {
  // Always set CORS headers
  setCors(res);

  // ✅ Handle preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Use POST" });
  }

  // If env vars missing, return a real JSON error (not a network failure)
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    return sendJson(res, 500, {
      error: "Server misconfigured: missing eBay credentials",
    });
  }

  const body = req.body || {};
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== "2.0") {
    return sendJson(res, 400, rpcError(id ?? null, "Invalid jsonrpc", -32600));
  }

  try {
    if (method !== "tools/call") {
      return sendJson(res, 400, rpcError(id, "Invalid method", -32601));
    }

    const tool = params?.name;
    const args = params?.arguments || {};

    if (tool === "search_ebay") {
      const query = String(args?.query || "");
      const limit = clampInt(args?.limit, 1, 50, 25);

      const enriched = await searchEbayEnriched({ query, limit });

      return sendJson(
        res,
        200,
        rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(enriched) }],
        })
      );
    }

    return sendJson(res, 400, rpcError(id, `Unknown tool: ${tool}`, -32601));
  } catch (e) {
    console.error("MCP runtime error:", e);
    return sendJson(res, 200, rpcError(id ?? null, String(e?.message || e)));
  }
};


