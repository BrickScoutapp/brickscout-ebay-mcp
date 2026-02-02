export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Health check (Base44 GET ping)
  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      server: "eBay MCP",
    });
  }

  // Accept POST even if body is empty
  const body =
    typeof req.body === "object" && req.body !== null ? req.body : {};

  const { id = "init", method = "initialize" } = body;

  // MCP initialize (must NEVER fail)
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

  // Safe fallback (never 400)
  return res.status(200).json({
    jsonrpc: "2.0",
    id,
    result: null,
  });
}
