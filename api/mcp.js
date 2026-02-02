export default async function handler(req, res) {
  // -----------------------------
  // CORS (must be first)
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // -----------------------------
  // Base44 health check (GET)
  // -----------------------------
  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      server: "eBay MCP",
    });
  }

  // -----------------------------
  // MCP JSON-RPC handling
  // -----------------------------
  const body = req.body || {};
  const { method, id, params } = body;

  // Initialize
  if (method === "initialize") {
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "eBay MCP",
          version: "1.0.0",
        },
      },
    });
  }

  // List tools
  if (method === "tools/list") {
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "search_ebay",
            description: "Search live eBay listings",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                limit: { type: "number" },
              },
              required: ["query"],
            },
          },
        ],
      },
    });
  }

  // Tool execution (stub for now)
  if (method === "tools/call") {
    const { name } = params || {};

    if (name === "search_ebay") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: "search_ebay tool is connected (logic coming next)",
            },
          ],
        },
      });
    }
  }

  // -----------------------------
  // Fallback
  // -----------------------------
  return res.status(400).json({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: "Method not found",
    },
  });
}
