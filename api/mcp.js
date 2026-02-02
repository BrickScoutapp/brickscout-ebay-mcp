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

  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const body = req.body;

  // Handle batch requests
  const requests = Array.isArray(body) ? body : [body];

  const responses = requests.map((reqItem) => {
    const { id, method } = reqItem || {};

    if (method === "initialize") {
      return {
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
      };
    }

    if (method === "tools/list") {
      return {
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
      };
    }

    if (method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: "Tool connected successfully (stub)",
            },
          ],
        },
      };
    }

    // Default safe response
    return {
      jsonrpc: "2.0",
      id,
      result: null,
    };
  });

  // Single request → single response
  return res.status(200).json(responses.length === 1 ? responses[0] : responses);
}
