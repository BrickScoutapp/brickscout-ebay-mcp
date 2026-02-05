// FULL REPLACEMENT MCP SERVER HANDLER
// Supports: query, limit, offset, sort
// sort: BEST_MATCH | PRICE_DESC | PRICE_ASC | ENDING_SOON

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = req.body || {};
    const method = body?.method;
    const toolName = body?.params?.name;
    const args = body?.params?.arguments || {};

    // Only handle the MCP tools/call pattern you’re already using
    if (method !== "tools/call" || toolName !== "search_ebay") {
      res.status(400).json({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        error: { message: "Unsupported method/tool" },
      });
      return;
    }

    const query = String(args?.query || "").trim();
    const limit = Number(args?.limit ?? 50);
    const offset = Number(args?.offset ?? 0);
    const sort = String(args?.sort || "BEST_MATCH").toUpperCase();

    if (!query) {
      res.status(200).json({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        result: { content: [{ type: "text", text: "[]" }] },
      });
      return;
    }

    // Map your UI sort to eBay Browse API sort names
    // eBay Browse API sort options include:
    // - price (asc/desc) by "price"
    // - ending soon: "endingSoonest"
    // - best match: default (omit)
    const ebaySort =
      sort === "PRICE_DESC"
        ? "price"
        : sort === "PRICE_ASC"
        ? "price"
        : sort === "ENDING_SOON"
        ? "endingSoonest"
        : null;

    const ebaySortOrder =
      sort === "PRICE_DESC" ? "DESC" : sort === "PRICE_ASC" ? "ASC" : null;

    // ✅ IMPORTANT:
    // This example assumes you are using the eBay Browse API (buy/browse/v1/item_summary/search)
    // and you have an OAuth App access token ready to use.
    //
    // You MUST set these env vars in Vercel:
    // - EBAY_BEARER_TOKEN  (OAuth token with browse scope)
    //
    // If your current server uses a different auth flow, paste it here and I’ll adapt it.

    const token = process.env.EBAY_BEARER_TOKEN;
    if (!token) {
      res.status(500).json({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        error: { message: "Missing EBAY_BEARER_TOKEN env var" },
      });
      return;
    }

    // Build eBay search URL
    const params = new URLSearchParams();
    params.set("q", query);
    params.set("limit", String(Math.min(Math.max(limit, 1), 200))); // eBay max varies; keep safe
    params.set("offset", String(Math.max(offset, 0)));

    // Sorting:
    // eBay browse uses: sort=endingSoonest OR sort=price
    // For price direction, we can use "sort" plus a filter; in some implementations,
    // price direction is controlled by sortOrder or by using "sort=price" + "sortOrder=DESC".
    if (ebaySort) params.set("sort", ebaySort);
    if (ebaySortOrder) params.set("sortOrder", ebaySortOrder);

    // Optional: keep it LEGO-ish but not overly restrictive
    // If you have categoryId for LEGO sets, you can include it:
    // params.set("category_ids", "183417");

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Optional affiliate headers if you use them:
        // "X-EBAY-C-ENDUSERCTX": "...",
      },
    });

    const text = await r.text();
    if (!r.ok) {
      res.status(r.status).json({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        error: { message: `eBay error (${r.status}): ${text}` },
      });
      return;
    }

    const data = JSON.parse(text);
    const items = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];

    // Normalize a bit so your client can keep using it?.price etc.
    const simplified = items.map((it) => {
      const priceVal = Number(it?.price?.value ?? 0);
      const shippingVal = Number(it?.shippingOptions?.[0]?.shippingCost?.value ?? 0);

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

    res.status(200).json({
      jsonrpc: "2.0",
      id: body?.id ?? 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(simplified) }],
      },
    });
  } catch (e) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: 1,
      error: { message: e?.message || String(e) },
    });
  }
}



