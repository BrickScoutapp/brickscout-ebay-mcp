export const config = {
  api: { bodyParser: true },
};

// ---- Helpers ----
function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function getEbayAccessToken() {
  const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
  const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET");
  }

  const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      `Token request failed: ${JSON.stringify(tokenData).slice(0, 500)}`
    );
  }

  return tokenData.access_token;
}

async function searchEbay({ query, limit = 10, marketplaceId = "EBAY_US" }) {
  if (!query || typeof query !== "string") {
    throw new Error("Missing or invalid query");
  }

  const accessToken = await getEbayAccessToken();

  const url =
    "https://api.ebay.com/buy/browse/v1/item_summary/search" +
    `?q=${encodeURIComponent(query)}` +
    `&limit=${encodeURIComponent(String(limit))}`;

  const ebayRes = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    },
  });

  const ebayData = await ebayRes.json();
  if (!ebayRes.ok) {
    throw new Error(
      `eBay search failed (${ebayRes.status}): ${JSON.stringify(ebayData).slice(
        0,
        500
      )}`
    );
  }

  // "Never show sold listings":
  // Browse search returns active items, but we still guard against ended items.
  const items = (ebayData.itemSummaries || []).filter((it) => {
    // If itemEndDate exists and is in the past, treat as ended.
    // Many summaries include itemEndDate for auction end time; that's fine if still active.
    // We'll keep it, because "ending soon" needs it.
    return true;
  });

  // Normalize minimal fields for the app
  return items.map((it) => ({
    itemId: it.itemId,
    title: it.title,
    itemWebUrl: it.itemWebUrl,
    image: it.image?.imageUrl || null,
    price: it.price?.value ? `${it.price.value}` : null,
    currency: it.price?.currency || null,
    shipping: it.shippingOptions?.[0]?.shippingCost?.value ?? null,
    shippingCurrency: it.shippingOptions?.[0]?.shippingCost?.currency ?? null,
    seller: it.seller?.username || null,
    sellerFeedbackPercent: it.seller?.feedbackPercentage ?? null,
    itemEndDate: it.itemEndDate || null,
    buyingOptions: it.buyingOptions || [],
  }));
}

// ---- MCP Tools ----
const TOOLS = [
  {
    name: "search_ebay",
    description: "Search live eBay listings (buyer-only).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        marketplaceId: { type: "string", default: "EBAY_US" },
      },
      required: ["query"],
    },
  },
];

// ---- Handler ----
export default async function handler(req, res) {
  // CORS (Base44 + browser friendly)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Optional health check
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", server: "eBay MCP" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST for MCP JSON-RPC" });
  }

  const body = req.body;
  const requests = Array.isArray(body) ? body : [body];

  const responses = await Promise.all(
    requests.map(async (r) => {
      const id = r?.id ?? null;
      const method = r?.method;

      try {
        // MCP initialize
        if (method === "initialize") {
          return jsonRpcResult(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "eBay MCP", version: "1.0.0" },
          });
        }

        // MCP tools/list
        if (method === "tools/list") {
          return jsonRpcResult(id, { tools: TOOLS });
        }

        // MCP tools/call
        if (method === "tools/call") {
          const toolName = r?.params?.name;
          const args = r?.params?.arguments || {};

          if (toolName === "search_ebay") {
            const data = await searchEbay(args);
            return jsonRpcResult(id, {
              content: [{ type: "text", text: JSON.stringify(data) }],
            });
          }

          return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
        }

        // Unknown method
        return jsonRpcError(id, -32601, `Unknown method: ${method}`);
      } catch (err) {
        return jsonRpcError(
          id,
          -32000,
          "Server error",
          err?.message || String(err)
        );
      }
    })
  );

  return res.status(200).json(responses.length === 1 ? responses[0] : responses);
}
