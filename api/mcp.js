export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Tool discovery (GET)
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

  // MCP JSON-RPC (POST)
  if (req.method === "POST") {
    const { method, id } = req.body || {};

    if (method === "initialize") {
  return res.status(200).json({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "eBay MCP",
        version: "1.0.0"
      }
    }
  });
}

    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      result: null
    });
  }

  res.status(405).end();
}
