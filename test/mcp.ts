import { MultiServerMCPClient } from "@langchain/mcp-adapters";

async function main() {
  const client = new MultiServerMCPClient({
    miyami: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "miyami-websearch-mcp"],
    },
  });

  const tools = await client.getTools();

  console.log(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }))
  );
}

main().catch(console.error);