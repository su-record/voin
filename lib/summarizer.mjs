// 요약: 기록을 여러 방법 중 하나로 요약한다. 받아쓰기·화자 분리와 달리 Ollama 말고는 기록이 외부 서버로 간다.
//  - 명령줄 도구: Claude Code, Codex — 사용자가 이미 로그인한 도구를 그대로 부른다 (voin은 로그인 정보를 갖지 않는다)
//  - Ollama: 이 맥에서 돌아가는 로컬 모델 (외부 전송 없음)
//  - API 키: Anthropic, OpenAI, xAI(Grok), Google Gemini, OpenRouter, OpenAI 호환 주소. 키는 맥 키체인에 둔다
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listLoginModels, loginStatus, summarizeWithLogin } from "./oauth-login.mjs";
import { DATA_DIR } from "./settings.mjs";

const WORK_DIR = path.join(DATA_DIR, "summary"); // 명령줄 도구가 프로젝트 설정을 읽지 않도록 빈 폴더에서 실행
const TIMEOUT_MS = 10 * 60 * 1000;
const OLLAMA = "http://127.0.0.1:11434";

// kind: cli | local | api. auto는 이 순서대로 쓸 수 있는 첫 번째를 고른다.
export const PROVIDERS = [
  { id: "claude", kind: "cli", name: "Claude Code", command: "claude", company: "Anthropic" },
  { id: "codex", kind: "cli", name: "Codex", command: "codex", company: "OpenAI" },
  { id: "chatgpt", kind: "login", name: "ChatGPT 로그인", company: "OpenAI (ChatGPT 구독) · Codex 로그인 방식을 빌려 씀" },
  { id: "grok", kind: "login", name: "Grok 로그인", company: "xAI (SuperGrok·X Premium+ 구독) · Grok CLI 로그인 방식을 빌려 씀" },
  { id: "anthropic", kind: "api", name: "Anthropic API", company: "Anthropic", keyUrl: "https://console.anthropic.com/settings/keys", defaultModel: "claude-sonnet-5-5" },
  { id: "openai", kind: "api", name: "OpenAI API", company: "OpenAI", base: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", prefer: ["gpt-5", "gpt-4.1", "gpt-4o"] },
  { id: "xai", kind: "api", name: "xAI Grok API", company: "xAI", base: "https://api.x.ai/v1", keyUrl: "https://console.x.ai", prefer: ["grok-4.3", "grok-4.5"] }, // grok-4는 2026-05-15 종료
  { id: "gemini", kind: "api", name: "Google Gemini API", company: "Google", base: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey", prefer: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini"] },
  { id: "openrouter", kind: "api", name: "OpenRouter", company: "OpenRouter (여러 회사 모델)", base: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys" },
  { id: "custom", kind: "api", name: "OpenAI 호환 주소", company: "직접 입력한 서버 (LM Studio·사내 게이트웨이 등)" },
  { id: "ollama", kind: "local", name: "Ollama", company: "이 맥 (외부 전송 없음)", keyUrl: "https://ollama.com/download" },
];
const byId = (id) => PROVIDERS.find((p) => p.id === id);

const INSTRUCTIONS = `너는 녹음 기록(회의·인터뷰·메모)을 요약한다. 입력은 "[시각] **화자**: 말" 형식의 받아쓴 기록이다.
받아쓰기 오류가 섞여 있을 수 있으니 문맥으로 뜻을 짐작하되, 기록에 없는 사실·이름·숫자·기한은 만들지 않는다.
화자 이름은 기록에 적힌 그대로 쓴다(예: "화자 1").
아래 Markdown 형식 그대로, 한국어로, 형식 밖의 말(인사, 설명, 코드 블록) 없이 출력한다. 해당 내용이 없으면 "- 없음"이라고 적는다.

> (무엇에 대한 녹음인지 한 문장)

### 핵심 내용
- (중요한 내용 3~7개)

### 결정 사항
- (정한 것)

### 할 일
- [ ] (담당 화자): (할 일) (기한이 언급됐으면 기한)

### 남은 질문·논의할 것
- (결론이 나지 않았거나 다시 다룰 것)`;

// ───────── 명령줄 도구 ─────────

// 로그인 셸로 실행해야 사용자가 설치한 경로(PATH)와 로그인 정보를 그대로 쓴다
function run(args, { input, cwd, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", 'exec "$0" "$@"', ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? -1 : code, stdout, stderr, timedOut: signal === "SIGTERM" });
    });
    child.stdin.end(input ?? "");
  });
}

// 로그인 셸에서 찾고, 없으면 흔한 설치 위치를 본다 (.zshrc에만 경로를 적어 둔 경우 로그인 셸에 안 잡힌다)
const COMMON_DIRS = [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin"]
  .map((d) => path.join(os.homedir(), d))
  .concat(["/opt/homebrew/bin", "/usr/local/bin"]);
async function which(command) {
  const found = await new Promise((resolve) =>
    execFile("/bin/zsh", ["-lc", `command -v ${command}`], { timeout: 10000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null)),
  );
  if (found?.startsWith("/")) return found;
  return COMMON_DIRS.map((d) => path.join(d, command)).find((f) => fs.existsSync(f)) ?? null;
}

async function cliStatus(p) {
  const bin = await which(p.command);
  if (!bin) return { installed: false, ready: false, status: "설치 안 됨" };
  if (p.id === "claude") {
    const { stdout } = await run([bin, "auth", "status"]);
    let loggedIn = false;
    try {
      loggedIn = JSON.parse(stdout).loggedIn === true;
    } catch {}
    return { installed: true, ready: loggedIn, path: bin, status: loggedIn ? "설치됨 · 로그인됨" : "로그인 필요 — 터미널에서 'claude' 실행 후 로그인" };
  }
  const { code, stdout, stderr } = await run([bin, "login", "status"]);
  const loggedIn = code === 0 && /logged in/i.test(stdout + stderr);
  return { installed: true, ready: loggedIn, path: bin, status: loggedIn ? "설치됨 · 로그인됨" : "로그인 필요 — 터미널에서 'codex login'" };
}

async function summarizeWithCli(p, info, transcript, options, instructions = INSTRUCTIONS) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  let result;
  if (p.id === "claude") {
    result = await run(
      [info.path, "-p", ...(options.model ? ["--model", options.model] : []), "--output-format", "text", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", instructions],
      { input: transcript, cwd: WORK_DIR, timeout: TIMEOUT_MS },
    );
  } else {
    const outFile = path.join(WORK_DIR, `codex-${process.pid}-${Date.now()}.md`);
    result = await run(
      [info.path, "exec", ...(options.model ? ["-m", options.model] : []), "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", WORK_DIR, "-o", outFile, `${instructions}\n\n아래 <stdin>이 대상 기록이다.`],
      { input: transcript, cwd: WORK_DIR, timeout: TIMEOUT_MS },
    );
    result.stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
    fs.rmSync(outFile, { force: true });
  }
  if (result.timedOut) throw new Error(`${p.name} 응답이 10분 안에 오지 않았습니다.`);
  const text = result.stdout.trim();
  if (result.code !== 0 || !text) {
    const reason = result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `종료 코드 ${result.code}`;
    throw new Error(`${p.name} 요약 실패: ${reason}`);
  }
  return text;
}

// ───────── API 키 (맥 키체인) ─────────

const KEYCHAIN_ACCOUNT = "voin";
const keychainService = (id) => `voin 요약 API 키 (${id})`;

function security(args) {
  return new Promise((resolve) => execFile("/usr/bin/security", args, { timeout: 10000 }, (error, stdout) => resolve(error ? null : stdout)));
}
export async function getApiKey(id) {
  return (await security(["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", keychainService(id), "-w"]))?.trim() || null;
}
export async function saveApiKey(id, key) {
  if (!byId(id) || byId(id).kind !== "api") throw new Error("API 키를 쓰지 않는 방식입니다.");
  if (key) {
    if ((await security(["add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT, "-s", keychainService(id), "-w", key])) === null) {
      throw new Error("키체인에 저장하지 못했습니다.");
    }
  } else {
    await security(["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", keychainService(id)]);
  }
  cache = null;
}

function apiBase(p, options) {
  return (p.id === "custom" ? options.customUrl : p.base)?.replace(/\/+$/, "");
}

async function httpJson(url, init, what) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? TIMEOUT_MS) });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    const reason = data?.error?.message ?? data?.error ?? data?.message ?? text.slice(0, 200);
    throw new Error(`${what} 실패 (${response.status}): ${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
  }
  return data;
}

// 고를 수 있는 모델 목록 (키·주소가 맞는지 확인하는 역할도 한다)
export async function listModels(id, options = {}) {
  const p = byId(id);
  if (p.kind === "local") {
    const data = await httpJson(`${OLLAMA}/api/tags`, { timeout: 3000 }, "Ollama 모델 목록");
    return data.models.map((m) => m.name);
  }
  if (p.kind === "login") return listLoginModels(id);
  // Claude Code는 목록을 주는 명령이 없어 알려진 모델을 보여 준다 (비우면 Claude Code 기본 모델)
  if (p.id === "claude") return ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"];
  if (p.kind !== "api") return [];
  const key = await getApiKey(id);
  if (!key && p.id !== "custom") throw new Error("API 키를 먼저 등록하세요.");
  if (p.id === "anthropic") {
    const data = await httpJson("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, timeout: 15000 }, "모델 목록");
    return data.data.map((m) => m.id);
  }
  const base = apiBase(p, options);
  if (!base) throw new Error("서버 주소를 먼저 입력하세요.");
  const data = await httpJson(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, timeout: 15000 }, "모델 목록");
  return (data.data ?? data.models ?? []).map((m) => (m.id ?? m.name ?? "").replace(/^models\//, "")).filter(Boolean);
}

// 모델을 고르지 않았으면 회사별로 무난한 것을 고른다 (요약에 맞지 않는 음성·이미지·임베딩 모델 제외)
async function resolveModel(p, options) {
  if (options.model) return options.model;
  if (p.defaultModel) return p.defaultModel;
  const models = (await listModels(p.id, options)).filter((m) => !/embed|tts|whisper|transcribe|audio|realtime|image|dall-e|moderation|vision|search/i.test(m));
  const pick = (p.prefer ?? []).map((want) => models.find((m) => m.startsWith(want) && !/mini|nano|lite/.test(m))).find(Boolean) ?? models[0];
  if (!pick) throw new Error(`${p.name}: 쓸 수 있는 모델이 없습니다. 설정 → 요약에서 모델을 고르세요.`);
  return pick;
}

async function summarizeWithApi(p, transcript, options, instructions = INSTRUCTIONS) {
  const model = await resolveModel(p, options);
  if (p.kind === "local") {
    const data = await httpJson(
      `${OLLAMA}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: false, options: { num_ctx: 32768 }, messages: [{ role: "system", content: instructions }, { role: "user", content: transcript }] }),
      },
      "Ollama 요약",
    );
    return { text: data.message?.content ?? "", model };
  }
  const key = await getApiKey(p.id);
  if (!key && p.id !== "custom") throw new Error(`${p.name} 키가 없습니다.`);
  if (p.id === "anthropic") {
    const data = await httpJson(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 4096, system: instructions, messages: [{ role: "user", content: transcript }] }),
      },
      `${p.name} 요약`,
    );
    return { text: data.content?.map((c) => c.text ?? "").join("") ?? "", model };
  }
  const base = apiBase(p, options);
  const data = await httpJson(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: instructions }, { role: "user", content: transcript }] }),
    },
    `${p.name} 요약`,
  );
  return { text: data.choices?.[0]?.message?.content ?? "", model };
}

// ───────── 상태·선택·실행 ─────────

// 설치·로그인·키 상태. 명령줄 도구 확인에 몇 초 걸려서 1분 동안 기억해 둔다.
let cache = null;
export async function detectProviders({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < 60000) return cache.list;
  const list = await Promise.all(
    PROVIDERS.map(async (p) => {
      if (p.kind === "cli") return { ...p, ...(await cliStatus(p)) };
      if (p.kind === "login") {
        const s = await loginStatus(p.id);
        return { ...p, installed: true, loggedIn: s.loggedIn, ready: s.loggedIn, status: s.loggedIn ? `로그인됨${s.email ? ` · ${s.email}` : ""}` : "로그인 안 됨" };
      }
      if (p.kind === "local") {
        try {
          const models = await listModels("ollama");
          return { ...p, installed: true, ready: models.length > 0, models, status: models.length ? `실행 중 · 모델 ${models.length}개` : "실행 중 · 받은 모델 없음 (터미널에서 'ollama pull 모델이름')" };
        } catch {
          return { ...p, installed: false, ready: false, status: "실행 중이 아님 (설치 후 Ollama 앱을 켜 두세요)" };
        }
      }
      const hasKey = Boolean(await getApiKey(p.id));
      if (p.id === "custom") return { ...p, hasKey, ready: hasKey, status: hasKey ? "키 등록됨" : "주소만 입력해도 됨 (키는 필요할 때만)" };
      return { ...p, hasKey, ready: hasKey, status: hasKey ? "키 등록됨" : "키 없음" };
    }),
  );
  cache = { at: Date.now(), list };
  return list;
}

// 설정값(auto | 방법 id | off)으로 쓸 방법을 고른다. auto는 목록 순서대로 쓸 수 있는 첫 번째.
export async function pickProvider(setting, options = {}) {
  if (setting === "off") return null;
  const list = await detectProviders();
  if (setting === "auto") return list.find((p) => p.ready && (p.id !== "custom" || options.customUrl)) ?? null;
  // 예전 설정값(claude/codex)도 그대로 쓴다
  const chosen = list.find((p) => p.id === setting);
  // OpenAI 호환 주소는 키 없이 주소만으로도 쓴다 (LM Studio 같은 로컬 서버)
  if (chosen?.id === "custom") return options.customUrl ? chosen : null;
  return chosen?.ready ? chosen : null;
}

// options: { model, customUrl } (설정 → 요약)
export async function summarize(provider, transcript, options = {}) {
  const p = byId(provider.id);
  const result =
    p.kind === "cli"
      ? { text: await summarizeWithCli(p, provider, transcript, options), model: options.model }
      : p.kind === "login"
        ? await summarizeWithLogin(p.id, transcript, INSTRUCTIONS, options.model)
        : await summarizeWithApi(p, transcript, options);
  const text = result.text.trim();
  if (!text) throw new Error(`${p.name}가 빈 요약을 돌려줬습니다.`);
  return { text, by: result.model ? `${p.name} (${result.model})` : p.name };
}

// ───────── 화자 이름 추천 ─────────
// 기록 속 호칭("김과장님")·자기소개("저는 박지은입니다")·다른 사람이 부른 이름을 근거로 화자 이름 후보를 찾는다.
// 근거가 없으면 추천하지 않는다. 결과: { "화자 1": { name, reason } }
const NAME_INSTRUCTIONS = `너는 받아쓴 녹음 기록에서 "화자 N"/"원격 N"의 실제 이름이나 호칭을 찾는다.
근거는 기록 안에서만 찾는다: 자기소개, 다른 사람이 그 화자를 부른 말(예: 화자 1이 "김과장님 어떻게 보세요?" 하자 화자 2가 바로 답함), 본인이 밝힌 직함.
근거가 약하면 그 화자는 빼라. 추측으로 이름을 만들지 마라. 받아쓰기 오류가 있을 수 있다.
아래 JSON 하나만 출력한다(설명·코드 블록 없이). reason은 한국어 한 문장, 근거가 된 말을 짧게 인용한다.
{"화자 1": {"name": "김과장", "reason": "화자 3이 '김과장님'이라 부르자 화자 1이 답함"}}
추천할 화자가 없으면 {}를 출력한다.`;

export async function suggestSpeakerNames(provider, transcript, options = {}) {
  const p = byId(provider.id);
  const ask = (instructions) =>
    p.kind === "cli"
      ? summarizeWithCli(p, provider, transcript, options, instructions)
      : p.kind === "login"
        ? summarizeWithLogin(p.id, transcript, instructions, options.model).then((r) => r.text)
        : summarizeWithApi(p, transcript, options, instructions).then((r) => r.text);
  const raw = await ask(NAME_INSTRUCTIONS);
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json || "{}");
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([label, v]) => /^(화자|원격) \d+$/.test(label) && v?.name && typeof v.name === "string" && !/[*[\]\n]/.test(v.name))
      .map(([label, v]) => [label, { name: v.name.trim().slice(0, 30), reason: String(v.reason ?? "").slice(0, 200) }]),
  );
}
