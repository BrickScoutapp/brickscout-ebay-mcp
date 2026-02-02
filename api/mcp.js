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

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      server: "eBay MCP",
    });
  }

  // MCP requires POST
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const body =
    typeof req.body === "object" && req.body !== null ? req.body : {};

  const { id, method } = body;

  // MCP: initialize
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

  // MCP: tools/list (REQUIRED)
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
