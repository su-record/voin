// Claude Code 승인 연결: claude -p --permission-prompt-tool mcp__voin__approve 로 불린다 (stdio MCP 서버).
// Claude가 작업 폴더 밖 수정·명령 실행 등 허락이 필요한 도구를 쓰려 하면 이 도구를 부르고,
// 우리는 voin 서버(VOIN_URL)에 물어 화면의 승인 버튼 결과를 기다렸다가 돌려준다.
import readline from "node:readline";

const VOIN_URL = process.env.VOIN_URL ?? "http://127.0.0.1:4310";
const TURN_ID = process.env.VOIN_TURN ?? "";

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

const TOOL = {
  name: "approve",
  description: "voin 화면에서 사용자에게 도구 실행 허락을 받는다.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

async function decide({ tool_name, input }) {
  try {
    const response = await fetch(`${VOIN_URL}/api/agent/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn: TURN_ID, tool: tool_name, input }),
    });
    const { allow } = await response.json();
    return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "사용자가 voin에서 거절했습니다." };
  } catch (error) {
    return { behavior: "deny", message: `voin에 승인을 묻지 못했습니다: ${error.message}` };
  }
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "voin", version: "0.1.0" } });
  } else if (method === "tools/list") {
    reply(id, { tools: [TOOL] });
  } else if (method === "tools/call") {
    const decision = await decide(params?.arguments ?? {});
    reply(id, { content: [{ type: "text", text: JSON.stringify(decision) }] });
  } else if (id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "지원하지 않는 요청" } })}\n`);
  }
});
