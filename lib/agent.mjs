// 음성 작업: 말한 내용을 등록된 도구(Codex·Claude Code·Grok Build)에 보내 같은 대화를 이어 가며 일을 시킨다 (Discodex와 같은 생각).
//  - Codex: 공식 `codex app-server`(stdio JSON-RPC)에 지속 thread 하나. 승인 요청은 화면 버튼으로 답한다.
//  - Claude Code: 요청마다 `claude -p --resume <세션>`. 허락이 필요한 도구는 approval-mcp.mjs가 화면에 묻는다.
//  - Grok Build: `grok agent stdio`(ACP, Agent Client Protocol)에 폴더별 세션. 권한 요청은 화면 버튼으로 답한다.
// 사용자가 이미 등록한 도구(MCP 서버·스킬·설정)를 그대로 쓴다. 권한(permission)은 설정의 작업 권한을 따른다.
//   workspace: 작업 폴더 안 수정은 바로, 그 밖(폴더 밖 수정·네트워크·위험 명령)은 승인
//   read-only: 읽기·조사만 / full: 승인 없이 모두
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { t } from "./i18n.mjs";
import { DATA_DIR } from "./settings.mjs";

const STATE_FILE = path.join(DATA_DIR, "agent.json"); // { codex|claude|grok: { [폴더]: 대화 id } }
const APPROVAL_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "approval-mcp.mjs");

function loadState() {
  try {
    return { codex: {}, claude: {}, grok: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return { codex: {}, claude: {}, grok: {} };
  }
}
function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// 대화 기록(화면에 다시 그릴 용도). 폴더마다 따로 보여 주도록 항목에 folder를 붙인다 (전체 최근 1000개)
const HISTORY_FILE = path.join(DATA_DIR, "agent-history.json");
function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}
export function agentHistory(folder) {
  return readHistory().filter((h) => h.folder === folder);
}
// 폴더별 마지막 대화 시각 (폴더 목록에 "3시간 전"으로 보인다)
export function agentLastActivity() {
  const last = {};
  for (const h of readHistory()) last[h.folder] = h.at;
  return last;
}
// 폴더를 붙이기 전의 예전 기록은 그때 쓰던 폴더의 것으로 한 번만 고쳐 둔다
export function tagOldHistory(folder) {
  const list = readHistory();
  if (!folder || list.every((h) => h.folder)) return;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.map((h) => ({ ...h, folder: h.folder ?? folder }))));
}
let currentFolder = null; // 지금 대화 중인 폴더 (기록에 붙인다)
function remember(entry) {
  const list = [...readHistory(), { at: Date.now(), folder: currentFolder ?? undefined, ...entry }].slice(-1000);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list));
}

const loginShell = (command, args, options) => spawn("/bin/zsh", ["-lc", 'exec "$0" "$@"', command, ...args], options);

// ───────── Codex app-server ─────────
class CodexEngine {
  constructor(events) {
    this.events = events; // { delta, activity, approval, done }
    this.child = null;
    this.nextId = 0;
    this.waiting = new Map();
    this.turn = null; // { threadId, turnId, text }
  }

  async ensure() {
    if (this.child && this.child.exitCode === null) return;
    this.child = loginShell("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", () => {});
    this.child.on("exit", () => {
      for (const w of this.waiting.values()) w.reject(new Error(t("Codex가 종료되었습니다.")));
      this.waiting.clear();
      if (this.turn) this.finish(t("Codex가 종료되었습니다."));
      this.child = null;
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    await this.request("initialize", { clientInfo: { name: "voin", title: "voin", version: "0.1.0" }, capabilities: null });
    this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      return m.error ? w.reject(new Error(m.error.message ?? JSON.stringify(m.error))) : w.resolve(m.result);
    }
    const p = m.params ?? {};
    // 서버가 묻는 승인 요청 → 화면 버튼
    if (m.id !== undefined && /requestApproval|execCommandApproval|applyPatchApproval/.test(m.method)) {
      const detail = p.command ?? (p.changes ? Object.keys(p.changes).join(", ") : null) ?? p.reason ?? m.method;
      const kind = /fileChange|Patch/.test(m.method) ? t("파일 수정") : /permissions/.test(m.method) ? t("권한 요청") : t("명령 실행");
      this.events.approval({ kind, detail: Array.isArray(detail) ? detail.join(" ") : String(detail), reason: p.reason }, (allow) =>
        this.write({ jsonrpc: "2.0", id: m.id, result: /permissions/.test(m.method) ? { permissions: allow ? p.permissions ?? {} : {}, scope: "turn" } : { decision: allow ? "accept" : "decline" } }),
      );
      return;
    }
    if (m.id !== undefined) {
      // 처리하지 않는 서버 요청(사용자 입력 폼 등)은 거절해 멈추지 않게 한다
      this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "voin에서 지원하지 않는 요청" } });
      return;
    }
    if (!this.turn || (p.threadId && p.threadId !== this.turn.threadId)) return;
    if (m.method === "item/agentMessage/delta") {
      this.turn.text += p.delta ?? "";
      this.events.delta(p.delta ?? "");
    } else if (m.method === "item/started") {
      const item = p.item ?? {};
      if (item.type === "commandExecution") this.events.activity(t("명령 실행: {command}", { command: Array.isArray(item.command) ? item.command.join(" ") : item.command ?? "" }));
      else if (item.type === "fileChange") this.events.activity(t("파일 수정: {files}", { files: (item.changes ?? []).map((c) => c.path).join(", ") }));
      else if (item.type === "mcpToolCall") this.events.activity(t("도구 사용: {tool}", { tool: `${item.server ?? ""} ${item.tool ?? ""}`.trim() }));
      else if (item.type === "webSearch") this.events.activity(t("웹 검색: {query}", { query: item.query ?? "" }));
    } else if (m.method === "turn/completed") {
      const error = p.turn?.status === "failed" ? (p.turn?.error?.message ?? t("작업이 실패했습니다.")) : null;
      this.finish(error);
    } else if (m.method === "error") {
      this.events.activity(t("오류: {message}", { message: p.error?.message ?? p.message ?? "" }));
    }
  }

  finish(error) {
    const turn = this.turn;
    this.turn = null;
    this.events.done(turn?.text ?? "", error);
  }

  async send(text, { cwd, permission, model }) {
    await this.ensure();
    const state = loadState();
    const policy =
      permission === "read-only"
        ? { sandbox: "read-only", approvalPolicy: "on-request" }
        : permission === "full"
          ? { sandbox: "danger-full-access", approvalPolicy: "never" }
          : { sandbox: "workspace-write", approvalPolicy: "on-request" };
    let threadId = state.codex[cwd];
    if (threadId) {
      try {
        await this.request("thread/resume", { threadId, cwd, ...policy, ...(model ? { model } : {}) });
      } catch {
        threadId = null; // 지난 대화를 못 찾으면 새로
      }
    }
    if (!threadId) {
      const started = await this.request("thread/start", { cwd, ...policy, ...(model ? { model } : {}) });
      threadId = started.thread.id;
      state.codex[cwd] = threadId;
      saveState(state);
    }
    this.turn = { threadId, turnId: null, text: "" };
    const result = await this.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
    if (this.turn) this.turn.turnId = result?.turn?.id ?? null;
  }

  async interrupt() {
    if (this.turn?.turnId) await this.request("turn/interrupt", { threadId: this.turn.threadId, turnId: this.turn.turnId }).catch(() => {});
  }

  // 진행 중인 작업에 말을 더한다 (Codex turn/steer). 진행 중이 아니면 false
  async steer(text) {
    if (!this.turn?.turnId) return false;
    await this.request("turn/steer", { threadId: this.turn.threadId, input: [{ type: "text", text, text_elements: [] }], expectedTurnId: this.turn.turnId });
    return true;
  }

  newConversation(cwd) {
    const state = loadState();
    delete state.codex[cwd];
    saveState(state);
  }

  stop() {
    this.child?.kill();
  }
}

// ───────── Claude Code ─────────
class ClaudeEngine {
  constructor(events, voinUrl) {
    this.events = events;
    this.voinUrl = voinUrl;
    this.child = null;
  }

  async send(text, { cwd, permission, model, turnId }) {
    const state = loadState();
    const session = state.claude[cwd];
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (session) args.push("--resume", session);
    if (model) args.push("--model", model);
    if (permission === "read-only") args.push("--permission-mode", "plan");
    else if (permission === "full") args.push("--permission-mode", "bypassPermissions");
    else {
      // 작업 폴더 안 수정은 바로, 그 밖에 허락이 필요한 도구는 voin 화면에서 승인
      const mcp = { mcpServers: { voin: { command: process.execPath, args: [APPROVAL_MCP], env: { VOIN_URL: this.voinUrl, VOIN_TURN: turnId } } } };
      args.push("--permission-mode", "acceptEdits", "--mcp-config", JSON.stringify(mcp), "--permission-prompt-tool", "mcp__voin__approve");
    }
    args.push(text);
    let answer = "";
    let error = null;
    this.child = loginShell("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    this.child.stderr.on("data", (d) => (stderr += d));
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.session_id && e.session_id !== loadState().claude[cwd]) {
        const s = loadState();
        s.claude[cwd] = e.session_id;
        saveState(s);
      }
      if (e.type === "assistant") {
        for (const c of e.message?.content ?? []) {
          if (c.type === "text" && c.text) {
            const chunk = (answer ? "\n\n" : "") + c.text;
            answer += chunk;
            this.events.delta(chunk);
          } else if (c.type === "tool_use") {
            const input = c.input ?? {};
            this.events.activity(`${c.name}: ${input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? ""}`.trim());
          }
        }
      } else if (e.type === "result" && e.is_error) {
        error = e.result ?? t("작업이 실패했습니다.");
      }
    });
    this.child.on("close", (code) => {
      this.child = null;
      if (!error && code !== 0 && !answer) error = stderr.trim().split("\n").at(-1) || t("종료 코드 {code}", { code });
      this.events.done(answer, error);
    });
  }

  async interrupt() {
    this.child?.kill("SIGINT");
  }

  newConversation(cwd) {
    const state = loadState();
    delete state.claude[cwd];
    saveState(state);
  }

  stop() {
    this.child?.kill();
  }
}

// ───────── Grok Build (ACP) ─────────
// `grok agent stdio`와 JSON-RPC로 대화한다: initialize → session/new·load(폴더별) → session/prompt.
// 진행은 session/update 알림으로, 도구 실행 허락은 session/request_permission 요청으로 온다.
// 권한: Grok이 허락을 물어 오면(session/request_permission) workspace는 폴더 안 수정·읽기는 바로, 나머지는 화면에서 승인 /
// read-only는 수정·실행 거절 / full은 모두 허락. 다만 사용자 Claude 설정이 auto 모드면 Grok이 스스로 판단해 위험한 작업은 막고
// 답에서 되묻기 때문에, 화면 승인까지 오지 않을 수 있다 (2026-10-16 확인)
const READ_KINDS = new Set(["read", "search", "think", "fetch"]);
class GrokEngine {
  constructor(events) {
    this.events = events;
    this.child = null;
    this.key = null; // 지금 띄운 grok의 모델 (바뀌면 다시 띄운다)
    this.nextId = 0;
    this.waiting = new Map();
    this.turn = null; // { sessionId, cwd, permission, text }
    this.canLoad = false;
  }

  async ensure(model) {
    const key = model ?? "";
    if (this.child && this.child.exitCode === null && this.key === key) return;
    this.stop();
    const args = ["agent", "--no-leader", ...(model ? ["-m", model] : []), "stdio"];
    this.child = loginShell("grok", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.key = key;
    this.child.stderr.on("data", () => {});
    this.child.on("exit", () => {
      for (const w of this.waiting.values()) w.reject(new Error(t("Grok이 종료되었습니다.")));
      this.waiting.clear();
      if (this.turn) this.finish(t("Grok이 종료되었습니다."));
      this.child = null;
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "voin", version: "0.1.0" },
    });
    this.canLoad = Boolean(init?.agentCapabilities?.loadSession);
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      return m.error ? w.reject(new Error(m.error.message ?? JSON.stringify(m.error))) : w.resolve(m.result);
    }
    const p = m.params ?? {};
    if (m.method === "session/request_permission" && m.id !== undefined) return this.permission(m.id, p);
    if (m.id !== undefined) {
      this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "voin에서 지원하지 않는 요청" } });
      return;
    }
    // 지난 대화를 불러올 때 다시 흘러나오는 기록은 무시한다 (진행 중인 작업의 알림만)
    if (m.method !== "session/update" || !this.turn || p.sessionId !== this.turn.sessionId) return;
    const u = p.update ?? {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      this.turn.text += u.content.text;
      this.events.delta(u.content.text);
    } else if (u.sessionUpdate === "tool_call") {
      this.events.activity(u.title || u.kind || t("도구 사용"));
    }
  }

  // 도구 실행 허락: 권한 설정에 따라 바로 답하거나 화면에 묻는다
  permission(id, p) {
    const options = p.options ?? [];
    const pick = (allow) => {
      const option = options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ?? options.find((o) => o.kind?.startsWith(allow ? "allow" : "reject"));
      this.write({ jsonrpc: "2.0", id, result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
    };
    const call = p.toolCall ?? {};
    const kind = call.kind ?? "other";
    const permission = this.turn?.permission ?? "workspace";
    const cwd = this.turn?.cwd ?? "";
    const inside = (call.locations ?? []).length > 0 && call.locations.every((l) => l.path && path.resolve(cwd, l.path).startsWith(`${cwd}${path.sep}`));
    if (permission === "full" || READ_KINDS.has(kind)) return pick(true);
    if (permission === "read-only") {
      this.events.activity(t("거절함 (읽기만 허용): {title}", { title: call.title ?? kind }));
      return pick(false);
    }
    if (kind === "edit" && inside) return pick(true);
    const label = kind === "execute" ? t("명령 실행") : kind === "edit" || kind === "delete" || kind === "move" ? t("파일 수정") : t("도구 사용");
    this.events.approval({ kind: label, detail: call.title ?? kind }, pick);
  }

  finish(error) {
    const turn = this.turn;
    this.turn = null;
    this.events.done(turn?.text ?? "", error);
  }

  async send(text, { cwd, permission, model }) {
    await this.ensure(model);
    const state = loadState();
    let sessionId = state.grok[cwd];
    if (sessionId && this.canLoad) {
      try {
        await this.request("session/load", { sessionId, cwd, mcpServers: [] });
      } catch {
        sessionId = null; // 지난 대화를 못 찾으면 새로
      }
    } else sessionId = null;
    if (!sessionId) {
      // "모두 허락" 설정이면 Grok도 묻지 않고 실행(yoloMode). 그 밖에는 Grok의 권한 규칙(사용자 Claude 설정의 auto 모드 포함)을 따른다
      sessionId = (await this.request("session/new", { cwd, mcpServers: [], _meta: permission === "full" ? { yoloMode: true } : {} })).sessionId;
      state.grok[cwd] = sessionId;
      saveState(state);
    }
    this.turn = { sessionId, cwd, permission, text: "" };
    try {
      const result = await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      if (this.turn) this.finish(result?.stopReason === "refusal" ? t("Grok이 요청을 거절했습니다.") : null);
    } catch (error) {
      if (this.turn) this.finish(error.message);
    }
  }

  async interrupt() {
    if (this.turn) this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.turn.sessionId } });
  }

  newConversation(cwd) {
    const state = loadState();
    delete state.grok[cwd];
    saveState(state);
  }

  stop() {
    this.child?.kill();
    this.child = null;
  }
}

// ───────── 바깥에서 쓰는 창구 ─────────
// emit(message): 화면으로 보낼 알림 { type: "agent-...", ... }
export function createAgent({ emit, voinUrl }) {
  const pendingApprovals = new Map(); // id → (allow) => void
  let busy = null; // { engine, turnId, startedAt }
  const queue = []; // 작업 중에 들어온 말 (끝나면 차례로 보낸다)
  let lastSettings = null;
  let approvalSeq = 0;

  const events = {
    delta: (text) => emit({ type: "agent-delta", text }),
    activity: (text) => {
      remember({ role: "activity", text });
      emit({ type: "agent-activity", text });
    },
    approval: (request, respond) => {
      const id = `a${++approvalSeq}`;
      pendingApprovals.set(id, respond);
      remember({ role: "approval", text: `${request.kind}: ${request.detail}` });
      emit({ type: "agent-approval", id, ...request });
    },
    done: (text, error) => {
      busy = null;
      for (const [id, respond] of pendingApprovals) {
        respond(false);
        pendingApprovals.delete(id);
      }
      if (text) remember({ role: "assistant", text });
      if (error) remember({ role: "error", text: error });
      emit({ type: "agent-done", text, error });
      // 작업 중에 말해 둔 것이 있으면 이어서 보낸다
      if (queue.length && lastSettings) {
        setTimeout(() => api.send(queue.shift(), lastSettings).catch((e) => emit({ type: "agent-done", error: e.message })), 300);
      }
    },
  };
  const engines = { codex: new CodexEngine(events), claude: new ClaudeEngine(events, voinUrl), grok: new GrokEngine(events) };

  const api = {
    get busy() {
      return busy;
    },
    // 작업 중에 한 말: Codex는 진행 중인 작업에 더하고(steer), 안 되면 끝난 뒤 보내도록 줄 세운다
    async add(text, settings) {
      if (!busy) return api.send(text, settings);
      // 작업 중 폴더를 바꿀 수 없으므로, 더하는 말은 진행 중인 작업의 폴더에 붙는다
      remember({ role: "user", text });
      try {
        if (busy.engine === "codex" && (await engines.codex.steer(text))) return emit({ type: "agent-steer", text });
      } catch {}
      queue.push(text);
      emit({ type: "agent-queued", text });
    },
    async send(text, settings) {
      if (busy) throw new Error(t("이전 작업이 끝나지 않았습니다. 멈춘 뒤 다시 시도하세요."));
      lastSettings = settings;
      const cwd = settings.agentFolder;
      currentFolder = cwd;
      if (!cwd || !fs.existsSync(cwd)) throw new Error(t("설정 → 음성 작업에서 작업 폴더를 고르세요."));
      const engine = engines[settings.agentEngine] ?? engines.codex;
      const turnId = `t${Date.now()}`;
      busy = { engine: settings.agentEngine, turnId, startedAt: Date.now() };
      remember({ role: "user", text });
      emit({ type: "agent-start", text, engine: settings.agentEngine });
      try {
        await engine.send(text, { cwd, permission: settings.agentPermission, model: settings.agentModels?.[settings.agentEngine], turnId });
      } catch (error) {
        events.done("", error.message);
      }
    },
    async interrupt() {
      if (!busy) return;
      await engines[busy.engine]?.interrupt();
    },
    newConversation(settings) {
      engines[settings.agentEngine]?.newConversation(settings.agentFolder);
      currentFolder = settings.agentFolder;
      remember({ role: "system", text: t("새 대화를 시작했습니다.") });
    },
    // Claude 승인 연결(approval-mcp)이 부른다: 사용자가 버튼을 누를 때까지 기다린다
    askApproval(tool, input) {
      return new Promise((resolve) => {
        const detail = input?.command ?? input?.file_path ?? input?.url ?? JSON.stringify(input).slice(0, 200);
        events.approval({ kind: tool, detail }, resolve);
      });
    },
    answerApproval(id, allow) {
      const respond = pendingApprovals.get(id);
      if (!respond) return false;
      pendingApprovals.delete(id);
      respond(Boolean(allow));
      remember({ role: "activity", text: allow ? t("승인함") : t("거절함") });
      emit({ type: "agent-approval-done", id, allow: Boolean(allow) });
      return true;
    },
    stop() {
      Object.values(engines).forEach((e) => e.stop());
    },
  };
  return api;
}
