export const config = { api: { bodyParser: true } };

const EBAY_ENV = (process.env.EBAY_ENV || "production").toLowerCase();
const EBAY_OAUTH =
  EBAY_ENV === "sandbox"
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";

const EBAY_BROWSE =
  EBAY_ENV === "sandbox"
    ? "https://api.sandbox.ebay.com/buy/browse/v1"
    : "https://api.ebay.com/buy/browse/v1";

// Default marketplace
const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

let tokenCache = { accessToken: null, expiresAtMs: 0 };

function sendJson(res, status, body) {
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
 * Browse API search does NOT behave like ebay.com search.
 * - Strip "-keyword" tokens (your frontend adds these)
 * - Strip super noisy operators
 */
function sanitizeBrowseQuery(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  const tokens = s.split(/\s+/g);

  // Remove minus tokens and obvious boolean operators that cause weird matching
  const cleaned = tokens.filter((t) => {
    if (!t) return false;
    if (t.startsWith("-")) return false; // <- KEY FIX
    if (t === "OR" || t === "AND" || t === "NOT") return false;
    return true;
  });

  // Avoid returning empty
  const out = cleaned.join(" ").trim();
  return out || s.replace(/-\S+/g, "").trim() || "";
}

/* -------------------------
   OAuth: Client Credentials
-------------------------- */
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAtMs - 30_000 > now) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  // ✅ Correct generic scope for Browse API
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
    throw new Error(`eBay OAuth failed (${resp.status}): ${t}`);
  }

  const data = await resp.json();
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAtMs = now + toNum(data.expires_in, 7200) * 1000;
  return tokenCache.accessToken;
}

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
    throw new Error(`eBay API error (${resp.status}) ${path}: ${t}`);
  }

  return resp.json();
}

/* -------------------------
   eBay Browse helpers
-------------------------- */
async function browseSearch({ query, limit }) {
  const lim = clampInt(limit, 1, 50, 25);

  // ✅ sanitize query so Browse search actually returns results
  const cleaned = sanitizeBrowseQuery(query);

  const params = new URLSearchParams({
    q: cleaned || "LEGO",
    limit: String(lim),
  });

  return ebayFetch(`/item_summary/search?${params.toString()}`);
}

async function browseGetItem(restItemId) {
  return ebayFetch(`/item/${encodeURIComponent(restItemId)}`);
}

// concurrency limiter
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

/**
 * Returns items in the shape your frontend expects
 * (matches your normalizeMcpToDealScoringShape)
 */
async function searchEbayEnriched({ query, limit }) {
  const search = await browseSearch({ query, limit });
  const summaries = Array.isArray(search?.itemSummaries) ? search.itemSummaries : [];

  // RESTful ids used for getItem: e.g. v1|123...|0
  const restIds = summaries.map((s) => s?.itemId).filter(Boolean);

  const details = await mapWithConcurrency(restIds, 5, async (rid) => {
    try {
      const d = await browseGetItem(rid);
      return { rid, ok: true, d };
    } catch (e) {
      return { rid, ok: false, error: String(e?.message || e) };
    }
  });

  const detailMap = new Map(details.filter((x) => x.ok).map((x) => [x.rid, x.d]));

  return summaries.map((s) => {
    const rid = s?.itemId || null;
    const d = rid ? detailMap.get(rid) : null;

    const legacyItemId = pickFirst(d?.legacyItemId, s?.legacyItemId, null);
    const title = pickFirst(d?.title, s?.title, "Untitled listing");

    const itemWebUrl = pickFirst(
      d?.itemWebUrl,
      s?.itemWebUrl,
      legacyItemId ? `https://www.ebay.com/itm/${legacyItemId}` : null,
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
      toNum(d?.price?.value, NaN) ||
      toNum(s?.price?.value, NaN) ||
      0;

    const shipping =
      toNum(d?.shippingOptions?.[0]?.shippingCost?.value, NaN) ||
      toNum(s?.shippingOptions?.[0]?.shippingCost?.value, NaN) ||
      0;

    const sellerUsername = pickFirst(
      d?.seller?.username,
      s?.seller?.username,
      "eBay Seller"
    );

    const sellerFeedbackPercent =
      toNum(d?.seller?.feedbackPercentage, NaN) ||
      toNum(s?.seller?.feedbackPercentage, NaN) ||
      99;

    return {
      // IMPORTANT: keep this compatible with your frontend normalizer
      itemId: legacyItemId || rid,
      title,
      price,
      shipping, // <- your frontend uses it.shipping
      seller: sellerUsername,
      sellerFeedbackPercent,
      itemWebUrl,
      image: imageUrl || null,
      itemEndDate: pickFirst(d?.itemEndDate, s?.itemEndDate, null),
      buyingOptions: Array.isArray(s?.buyingOptions) ? s.buyingOptions : [],
    };
  });
}

/* -------------------------
   MCP JSON-RPC handler
-------------------------- */
export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });

  const body = req.body || {};
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== "2.0") {
    return sendJson(res, 400, rpcError(id ?? null, "Invalid jsonrpc", -32600));
  }

  try {
    if (method !== "tools/call") {
      return sendJson(res, 400, rpcError(id, `Unknown method: ${method}`, -32601));
    }

    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === "search_ebay") {
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

    return sendJson(res, 400, rpcError(id, `Unknown tool: ${toolName}`, -32601));
  } catch (e) {
    return sendJson(res, 200, rpcError(id ?? null, String(e?.message || e)));
  }
}


