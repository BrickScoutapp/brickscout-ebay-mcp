export default async function handler(req, res) {
  // CORS (Base44 requires this)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Health check (GET)
  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      server: "eBay MCP",
    });
  }

  // MCP requires POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { jsonrpc, id, method } = req.body || {};

  // MCP initialize
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

  // Fallback (important: NEVER 400 here)
  return res.status(200).json({
    jsonrpc: "2.0",
    id,
    result: null,
  });
}
