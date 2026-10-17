// ChatGPT·Grok 구독 로그인: hermes-agent(0.19.0, hermes_cli/auth.py)와 같은 방식으로 로그인하고 요약을 요청한다.
//  - ChatGPT: OpenAI Codex CLI의 로그인(기기 코드)을 빌려 쓴다. 요청은 chatgpt.com/backend-api/codex (Responses 형식)
//  - Grok: xAI Grok CLI의 로그인(기기 코드, auth.x.ai)을 빌려 쓴다. 요청은 api.x.ai/v1/responses
// 공식적으로 다른 앱에 열린 로그인이 아니라서, 회사(OpenAI·xAI)가 막으면 예고 없이 안 될 수 있다.
// 토큰은 맥 키체인에 JSON으로 둔다.
import { execFile } from "node:child_process";
import { t } from "./i18n.mjs";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_ISSUER = "https://auth.x.ai";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_BASE = "https://api.x.ai/v1";

export const LOGINS = {
  chatgpt: { refreshSkew: 120, defaultModel: null },
  grok: { refreshSkew: 3600, defaultModel: "grok-4.3" },
};

// ───────── 키체인 ─────────
const service = (id) => `voin 로그인 (${id})`;
function security(args) {
  return new Promise((resolve) => execFile("/usr/bin/security", args, { timeout: 10000 }, (error, stdout) => resolve(error ? null : stdout)));
}
async function readTokens(id) {
  const raw = await security(["find-generic-password", "-a", "voin", "-s", service(id), "-w"]);
  try {
    return raw ? JSON.parse(raw.trim()) : null;
  } catch {
    return null;
  }
}
async function saveTokens(id, tokens) {
  if (tokens) await security(["add-generic-password", "-U", "-a", "voin", "-s", service(id), "-w", JSON.stringify(tokens)]);
  else await security(["delete-generic-password", "-a", "voin", "-s", service(id)]);
}

function jwtClaims(token) {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

export async function loginStatus(id) {
  const tokens = await readTokens(id);
  if (!tokens?.access_token) return { loggedIn: false };
  const claims = { ...jwtClaims(tokens.id_token ?? ""), ...jwtClaims(tokens.access_token) };
  return { loggedIn: true, email: claims.email ?? claims["https://api.openai.com/profile"]?.email ?? null };
}

export const logout = (id) => saveTokens(id, null);

async function form(url, data) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(data),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text };
}

// ───────── 기기 코드 로그인 ─────────
// start()는 사용자에게 보여 줄 코드·주소를 돌려주고, 승인될 때까지 뒤에서 기다리다 토큰을 저장한다.
const pending = new Map(); // id → { cancelled }

export async function startLogin(id, { onDone }) {
  pending.get(id)?.cancel?.();
  const state = { cancelled: false, cancel() { this.cancelled = true; } };
  pending.set(id, state);
  const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

  if (id === "chatgpt") {
    const response = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429) throw new Error(t("OpenAI가 로그인 요청을 잠시 막았습니다. 1분 뒤 다시 시도하세요."));
    if (!response.ok) throw new Error(t("로그인 코드를 받지 못했습니다 ({status}).", { status: response.status }));
    const device = await response.json();
    const interval = Math.max(3, Number(device.interval ?? 5));
    (async () => {
      const deadline = Date.now() + 15 * 60 * 1000;
      while (!state.cancelled && Date.now() < deadline) {
        await sleep(interval);
        const poll = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
        }).catch(() => null);
        if (!poll || poll.status === 403 || poll.status === 404) continue;
        if (!poll.ok) return onDone(t("로그인 확인 실패 ({status})", { status: poll.status }));
        const code = await poll.json();
        const token = await form(`${CODEX_ISSUER}/oauth/token`, {
          grant_type: "authorization_code",
          code: code.authorization_code,
          redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
          client_id: CODEX_CLIENT_ID,
          code_verifier: code.code_verifier,
        });
        if (token.status !== 200 || !token.json.access_token) return onDone(t("토큰 받기 실패 ({status})", { status: token.status }));
        await saveTokens(id, { access_token: token.json.access_token, refresh_token: token.json.refresh_token, id_token: token.json.id_token });
        return onDone(null);
      }
      if (!state.cancelled) onDone(t("15분 안에 승인되지 않았습니다."));
    })().catch((e) => onDone(e.message));
    return { userCode: device.user_code, url: `${CODEX_ISSUER}/codex/device`, expiresIn: 900 };
  }

  if (id === "grok") {
    const discovery = await (await fetch(`${XAI_ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) })).json();
    const device = await form(`${XAI_ISSUER}/oauth2/device/code`, { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE });
    if (device.status !== 200 || !device.json.device_code) throw new Error(t("로그인 코드를 받지 못했습니다 ({status}). {detail}", { status: device.status, detail: device.text.slice(0, 120) }));
    let interval = Math.max(1, Number(device.json.interval ?? 5));
    (async () => {
      const deadline = Date.now() + Number(device.json.expires_in ?? 900) * 1000;
      while (!state.cancelled && Date.now() < deadline) {
        await sleep(interval);
        const token = await form(discovery.token_endpoint, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: XAI_CLIENT_ID, device_code: device.json.device_code });
        if (token.status === 200 && token.json.access_token) {
          await saveTokens(id, { access_token: token.json.access_token, refresh_token: token.json.refresh_token, id_token: token.json.id_token, token_endpoint: discovery.token_endpoint });
          return onDone(null);
        }
        if (token.json.error === "authorization_pending") continue;
        if (token.json.error === "slow_down") {
          interval = Math.min(interval + 1, 30);
          continue;
        }
        return onDone(t("로그인 실패: {reason}", { reason: token.json.error_description ?? token.json.error ?? token.status }));
      }
      if (!state.cancelled) onDone(t("시간 안에 승인되지 않았습니다."));
    })().catch((e) => onDone(e.message));
    return { userCode: device.json.user_code, url: device.json.verification_uri_complete ?? device.json.verification_uri, expiresIn: Number(device.json.expires_in ?? 900) };
  }
  throw new Error(t("지원하지 않는 로그인입니다."));
}

export function cancelLogin(id) {
  pending.get(id)?.cancel?.();
  pending.delete(id);
}

// ───────── 토큰 갱신 ─────────
export async function accessToken(id) {
  const tokens = await readTokens(id);
  if (!tokens?.access_token) throw new Error(t("{name}에 로그인하세요.", { name: id === "chatgpt" ? "ChatGPT" : "Grok" }));
  const exp = jwtClaims(tokens.access_token).exp;
  if (!exp || exp * 1000 - Date.now() > LOGINS[id].refreshSkew * 1000) return tokens.access_token;
  const refreshed =
    id === "chatgpt"
      ? await form(`${CODEX_ISSUER}/oauth/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CODEX_CLIENT_ID })
      : await form(tokens.token_endpoint ?? `${XAI_ISSUER}/oauth2/token`, { grant_type: "refresh_token", client_id: XAI_CLIENT_ID, refresh_token: tokens.refresh_token });
  if (refreshed.status === 403 && id === "grok") throw new Error(t("이 Grok 계정은 API 사용이 허용되지 않았습니다 (xAI가 일부 구독 등급만 허용). xAI API 키를 쓰세요."));
  if (refreshed.status !== 200 || !refreshed.json.access_token) throw new Error(t("로그인이 만료되었습니다. 설정 → 요약에서 다시 로그인하세요. ({status})", { status: refreshed.status }));
  const next = { ...tokens, access_token: refreshed.json.access_token, refresh_token: refreshed.json.refresh_token ?? tokens.refresh_token, id_token: refreshed.json.id_token ?? tokens.id_token };
  await saveTokens(id, next);
  return next.access_token;
}

// ChatGPT(Codex) 요청은 Codex CLI처럼 보이는 머리글이 있어야 Cloudflare에서 막히지 않는다 (hermes와 같은 값)
function codexHeaders(token) {
  const headers = { authorization: `Bearer ${token}`, "user-agent": "codex_cli_rs/0.0.0 (voin)", originator: "codex_cli_rs" };
  const account = jwtClaims(token)["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (account) headers["ChatGPT-Account-ID"] = account;
  return headers;
}

export async function listLoginModels(id) {
  const token = await accessToken(id);
  if (id === "chatgpt") {
    const response = await fetch(`${CODEX_BASE}/models?client_version=1.0.0`, { headers: codexHeaders(token), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(t("모델 목록 실패 ({status})", { status: response.status }));
    const data = await response.json();
    return (data.models ?? [])
      .filter((m) => m.slug && !/^hid/i.test(m.visibility ?? ""))
      .sort((a, b) => (a.priority ?? 1e4) - (b.priority ?? 1e4))
      .map((m) => m.slug);
  }
  const response = await fetch(`${XAI_BASE}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) return ["grok-4.3", "grok-4.5"];
  return ((await response.json()).data ?? []).map((m) => m.id);
}

// Responses 형식의 응답(스트림 또는 한 번에)에서 글만 모은다
function outputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("");
}

export async function summarizeWithLogin(id, transcript, instructions, model) {
  const token = await accessToken(id);
  if (id === "chatgpt") {
    const chosen = model || (await listLoginModels(id))[0];
    if (!chosen) throw new Error(t("ChatGPT에서 쓸 모델을 찾지 못했습니다."));
    // Codex 서버는 store:false, stream:true만 받고 temperature·max_output_tokens는 받지 않는다
    const response = await fetch(`${CODEX_BASE}/responses`, {
      method: "POST",
      headers: { ...codexHeaders(token), "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ model: chosen, instructions, input: [{ role: "user", content: [{ type: "input_text", text: transcript }] }], store: false, stream: true }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!response.ok) throw new Error(t("ChatGPT 요약 실패 ({status}): {detail}", { status: response.status, detail: (await response.text()).slice(0, 200) }));
    let text = "";
    let final = null;
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5));
        if (event.type === "response.output_text.delta") text += event.delta ?? "";
        if (event.type === "response.completed") final = event.response;
        if (event.type === "response.failed" || event.type === "error") throw new Error(event.response?.error?.message ?? event.message ?? t("요약 실패"));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return { text: text || (final ? outputText(final) : ""), model: chosen };
  }
  const chosen = model || LOGINS.grok.defaultModel;
  const response = await fetch(`${XAI_BASE}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: chosen, instructions, input: [{ role: "user", content: transcript }], store: false }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const body = await response.text();
  if (response.status === 403) throw new Error(t("이 Grok 계정은 API 사용이 허용되지 않았습니다 (xAI가 일부 구독 등급만 허용). xAI API 키를 쓰세요."));
  if (!response.ok) throw new Error(t("Grok 요약 실패 ({status}): {detail}", { status: response.status, detail: body.slice(0, 200) }));
  return { text: outputText(JSON.parse(body)), model: chosen };
}
