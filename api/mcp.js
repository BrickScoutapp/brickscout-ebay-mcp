export default async function handler(req, res) {
  // MCP handshake / health check
  if (req.method === "GET") {
    return res.status(200).json({
      name: "eBay MCP",
      tools: [
        {
          name: "search_ebay",
          description: "Search live eBay listings",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number" }
            },
            required: ["query"]
          }
        }
      ]
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { tool, input } = req.body || {};

  if (!tool) {
    return res.status(200).json({ ok: true });
  }

  try {
    if (tool === "search_ebay") {
      const query = encodeURIComponent(input.query || "lego");
      const limit = input.limit || 12;

      const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization":
            "Basic " +
            Buffer.from(
              `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
            ).toString("base64"),
        },
        body:
          "grant_type=refresh_token&" +
          `refresh_token=${process.env.EBAY_REFRESH_TOKEN}`,
      });

      const tokenData = await tokenRes.json();

      const ebayRes = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${query}&limit=${limit}`,
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          },
        }
      );

      const data = await ebayRes.json();

      return res.json({
        items: data.itemSummaries || [],
      });
    }

    return res.status(400).json({ error: "Unknown tool" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
