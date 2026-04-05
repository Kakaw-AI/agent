import { MultiServerMCPClient } from "@langchain/mcp-adapters";
const client = new MultiServerMCPClient({
  miyami: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "miyami-websearch-mcp"],
  },
});

export default client;
