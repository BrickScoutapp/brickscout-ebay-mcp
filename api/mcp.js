export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "MCP expects POST" });
  }

  const { tool, input } = req.body;

  try {
    if (tool === "search_ebay") {
      const query = encodeURIComponent(input.query || "lego");
      const limit = input.limit || 10;

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
