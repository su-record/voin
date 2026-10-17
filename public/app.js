import { getLang, pickLang, setLang, t, translateDom } from "/shared/i18n.mjs";
import { dictionaryToText, parseDictionaryText } from "/shared/text-cleanup.mjs";

// 화면 언어: 시스템 언어(한·영·일, 아니면 영어). 고정된 화면 글은 여기서 한 번 바꾸고, 코드에서 만드는 글은 t()로
setLang(pickLang(navigator.languages));
document.documentElement.lang = getLang();
translateDom(document.body);
const LOCALE = { ko: "ko-KR", en: "en-US", ja: "ja-JP" }[getLang()] ?? "en-US";
const $ = (id) => document.getElementById(id);
const SOURCE_HUES = { 마이크: 215, 화상회의: 150, 녹음: 215 };

let ws = null;
let recording = false;
let audio = null; // { context, stream, node }
let timerHandle = null;
let settings = null;
let model = { state: "loading" }; // 받아쓰기 모델 상태 (서버가 "model" 메시지로 알려 줌)
const isMacApp = Boolean(window.webkit?.messageHandlers?.pickFolder);
let recordingStartedAt = null;
let processing = null; // 녹음 뒤 정리·파일 불러오기·중단된 녹음 정리 중이면 그 진행 글 (메뉴 막대 아이콘에 표시)

// 맥 앱(Swift)에 알린다: 메뉴 막대 아이콘·단축키가 이 값을 쓴다
function tellNative(message) {
  window.webkit?.messageHandlers?.native?.postMessage(JSON.stringify(message));
}
// 맥 앱: 아이콘을 macOS SF Symbols로 바꾼다. 앱이 그린 그림(알파 마스크)을 받아 글자색으로 칠한다
let sfSymbols = {};
function sfIcon({ url, w, h }) {
  const span = el("span", "sf");
  span.style.cssText = `--sf: url(${url}); width: ${w}px; height: ${h}px`;
  return span;
}
window.applySymbols = (map) => {
  sfSymbols = map;
  document.querySelectorAll("[data-symbol]").forEach((button) => {
    const symbol = map[`${button.dataset.symbol}@${button.dataset.symbolSize}`];
    if (!symbol) return;
    button.querySelector(":scope > svg, :scope > .sf")?.replaceWith(sfIcon(symbol));
  });
  if (typeof renderContextRow === "function") renderContextRow();
  requestAnimationFrame(() => document.body.classList.add("ready"));
};
if (isMacApp) {
  const wanted = [...document.querySelectorAll("[data-symbol]")].map((b) => ({ name: b.dataset.symbol, size: Number(b.dataset.symbolSize) }));
  tellNative({ type: "symbols", symbols: [...wanted, { name: "mic", size: 11 }, { name: "headphones", size: 11 }, { name: "xmark.circle.fill", size: 14 }] });
}

// 맥 앱: 창 배경이 유리라 웹 화면을 투명하게. 막대 가운데를 끌면 창이 움직인다 (제목줄이 없어서)
if (isMacApp) {
  document.body.classList.add("glass");
  setTimeout(() => document.body.classList.add("ready"), 800); // 아이콘이 오지 않아도 0.8초 뒤엔 보인다
}
// 막대 가운데는 언제나 끌 수 있다 (모델이 없을 때의 "설정 열기" 클릭은 앱이 끌기와 구분해 넘겨준다)
function reportDragRegions() {
  const r = $("barCenter").getBoundingClientRect();
  tellNative({ type: "dragRegions", rects: [{ x: r.x, y: r.y, w: r.width, h: r.height }] });
}
new ResizeObserver(reportDragRegions).observe(document.body);
function reportState() {
  tellNative({ type: "state", recording, startedAt: recordingStartedAt, busy: $("toggle").disabled && !recording, processing, model });
  reportDragRegions();
}

// ───────── 공통 ─────────

function hueOf(label) {
  if (label in SOURCE_HUES) return SOURCE_HUES[label];
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.codePointAt(0)) % 1000;
  // "화자 1", "화자 2"처럼 한 글자만 다른 이름도 색이 확 달라지도록 황금각(137.5°)씩 벌린다
  return Math.round(h * 137.508) % 360;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body && typeof options.body === "string" ? { "content-type": "application/json" } : undefined,
  });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error ?? t("요청 실패 ({status})", { status: response.status }));
  return data;
}

// 아래 판: 버튼마다 하나씩 열린다. name이 null이면 판을 닫고 막대만 남긴다 (창도 막대 높이로 줄어든다)
function showView(name) {
  const views = ["recordView", "folderView", "agentView", "listView", "fileView", "settingsView"];
  for (const view of views) $(view).hidden = view !== name;
  $("panel").hidden = !name;
  $("streamToggle").classList.toggle("active", name === "recordView" || name === "agentView");
  $("drawerToggle").classList.toggle("active", name === "listView" || name === "fileView");
  $("settingsButton").classList.toggle("active", name === "settingsView");
  if (name !== "fileView") document.querySelectorAll(".meeting-list button").forEach((b) => b.classList.remove("active"));
  tellNative({ type: "panel", open: Boolean(name), fit: name ? panelFit(name) : null });
  if (name === "recordView") $("transcript").scrollTop = $("transcript").scrollHeight;
}

// 내용이 적은 판(폴더 고르기, 녹음 전 실시간 글)은 창을 내용 높이만큼만 연다 → 텅 빈 판이 생기지 않는다
const BAR_HEIGHT = 56;
function panelFit(name) {
  const small = ["folderView", "listView"].includes(name) || (name === "recordView" && !recording && $("transcript").querySelector(".empty-state"));
  if (!small) return null;
  const pane = $(name);
  pane.classList.add("measuring");
  const height = BAR_HEIGHT + pane.offsetHeight + 1;
  pane.classList.remove("measuring");
  // 내용이 많으면(기록이 많은 목록 등) 사용자가 늘려 둔 높이를 쓴다
  return height > 480 ? null : Math.max(180, height);
}
// 판의 내용이 바뀌었을 때 (폴더 목록을 다 그렸을 때, 녹음을 시작했을 때) 높이를 다시 맞춘다
function refitPanel() {
  const name = openView();
  if (name) tellNative({ type: "panel", open: true, fit: panelFit(name) });
}
const openView = () => ["recordView", "folderView", "agentView", "listView", "fileView", "settingsView"].find((v) => !$(v).hidden) ?? null;

function setProcessing(text) {
  processing = text;
  if (typeof renderBar === "function") renderBar();
  reportState();
}

function setJobStatus(text) {
  $("jobStatus").textContent = text ?? "";
  $("jobStatus").hidden = !text;
}

function showNotice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

// 받아쓴 한 줄을 붙인다. 바로 앞 덩어리와 화자가 같으면 그 덩어리에 문단만 더한다.
function addLine(container, time, label, text, translation) {
  container.querySelector(".placeholder")?.remove();
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  let turn = container.lastElementChild;
  if (!turn?.classList.contains("turn") || turn.dataset.label !== label) {
    turn = document.createElement("div");
    turn.className = "turn";
    turn.dataset.label = label;
    const head = document.createElement("div");
    head.className = "turn-head";
    const name = document.createElement("span");
    name.className = "speaker";
    name.style.setProperty("--h", hueOf(label));
    name.textContent = label;
    const timeEl = document.createElement("time");
    timeEl.textContent = time;
    head.append(name, timeEl);
    turn.append(head);
    container.append(turn);
  }
  const body = document.createElement("p");
  body.textContent = text;
  body.dataset.time = time;
  turn.append(body);
  if (translation) turn.append(el("p", "translation", `↳ ${translation}`));
  if (atBottom) container.scrollTop = container.scrollHeight;
}

// ───────── 서버 연결 ─────────

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => setIdleButton();
  ws.onclose = () => {
    if (recording) stopAudio();
    setButton(t("서버 연결 끊김"), true);
    showNotice(t("서버와 연결이 끊겼습니다. 앱을 다시 실행하세요."));
  };
  ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
}

function handleMessage(m) {
  switch (m.type) {
    case "partial":
      $(`partial-${m.source}`).textContent = m.text;
      break;
    case "final":
      addLine($("transcript"), m.time, m.label, m.text);
      break;
    case "level":
      setLevel(m.source, m.level);
      break;
    case "warning":
      showNotice(m.message);
      break;
    case "error":
      showNotice(m.message);
      stopAudio();
      setIdleButton();
      break;
    case "processing":
    case "import-progress":
    case "recovery-progress":
      setJobStatus(m.message);
      setProcessing(m.message);
      break;
    case "stopped":
    case "import-done":
      setProcessing(null);
      setJobStatus(m.warning ?? null);
      setIdleButton();
      // 빈 녹음은 저장하지 않아 열 파일이 없다
      loadMeetingList().then(() => (m.file ? openMeeting(m.file) : newMeeting()));
      break;
    case "model":
      model = m;
      renderModelBar();
      renderBar();
      if (!recording) setIdleButton();
      if (!$("settingsView").hidden) loadModelList();
      guideSetup();
      break;
    case "models-changed":
      if (!$("settingsView").hidden) loadModelList();
      break;
    case "models-error":
      modelErrors[m.id] = m.message;
      if (!$("settingsView").hidden) loadModelList();
      break;
    case "summary-models-error":
      modelErrors[m.id] = m.message;
    // falls through
    case "summary-models-changed":
      if (!$("settingsView").hidden) {
        loadSummaryModelList();
        loadProviders();
      }
      break;
    case "recovery-done":
    case "recovery-error":
      setProcessing(null);
      setJobStatus(m.warning ? `${m.message} ${m.warning}` : m.message);
      loadMeetingList();
      break;
    case "summary-progress":
      summarizingFiles.add(m.file);
      setJobStatus(m.message);
      setProcessing(m.message);
      break;
    case "summary-done":
    case "summary-error":
      summarizingFiles.delete(m.file);
      setProcessing(null);
      setJobStatus(m.type === "summary-error" ? m.message : (m.message ?? t("요약을 붙였습니다.")));
      if (openFile === m.file && !$("fileView").hidden) openMeeting(m.file);
      break;
    case "login-done":
      if (m.error) setJobStatus(t("로그인 실패: {error}", { error: m.error }));
      if (!$("settingsView").hidden) loadProviders(true);
      break;
    case "agent-start":
    case "agent-delta":
    case "agent-activity":
    case "agent-approval":
    case "agent-approval-done":
    case "agent-done":
    case "agent-steer":
    case "agent-queued":
      handleAgentMessage(m);
      break;
    case "dictate-ready":
    case "dictate-partial":
    case "dictation":
    case "dictate-end":
      handleDictation(m);
      break;
    case "import-error":
      setProcessing(null);
      setJobStatus(t("불러오기 실패: {message}", { message: m.message }));
      break;
  }
}

// ───────── 받아쓰기 모델 (화면 맨 위 줄) ─────────

function renderModelBar() {
  const mb = (bytes) => Math.round(bytes / 1e6);
  const name = model.name ?? t("받아쓰기 모델");
  const texts = {
    loading: t("{name} 불러오는 중…", { name }),
    missing: model.paused
      ? t("{name} 내려받기를 멈췄습니다. 받은 곳부터 이어 받을 수 있습니다.", { name })
      : t("받아쓰기 모델({name})이 없습니다. 처음 한 번 내려받아야 합니다 ({size}MB).", { name, size: model.sizeMB }),
    downloading: model.verifying
      ? t("받은 파일을 확인하는 중…")
      : t("{name} 내려받는 중… {received} / {total}MB", { name, received: mb(model.received ?? 0), total: mb(model.total ?? 0) }),
    error: model.message,
  };
  // 모델이 없을 때는 띄우지 않는다: 막대 가운데 안내(누르면 모델 설정)와 처음 실행 때 열리는 모델 목록에서
  // 사용자가 직접 골라 받는다. 받는 중·불러오는 중·오류만 알린다
  $("modelBar").hidden = model.state === "ready" || model.state === "missing";
  $("modelBar").dataset.state = model.state;
  $("modelText").textContent = texts[model.state] ?? "";
  $("modelProgress").hidden = model.state !== "downloading";
  if (model.state === "downloading") {
    if (model.verifying) $("modelProgress").removeAttribute("value");
    else $("modelProgress").value = (model.received ?? 0) / (model.total || 1);
  }
  const action = {
    missing: model.paused ? t("이어 받기") : t("내려받기"),
    downloading: model.verifying ? null : t("취소"),
    error: model.canDownload ? t("다시 시도") : null,
  }[model.state];
  $("modelAction").hidden = !action;
  $("modelAction").textContent = action ?? "";

  // 사이드바 아래: 지금 쓰는 모델과 상태
  const percent = model.total ? Math.round(((model.received ?? 0) / model.total) * 100) : 0;
  $("modelChip").dataset.state = model.state;
  $("modelChipText").textContent =
    {
      ready: name,
      loading: t("{name} 불러오는 중", { name }),
      missing: t("{name} 없음", { name }),
      downloading: t("{name} 받는 중 {percent}%", { name, percent }),
      error: t("{name} 문제 있음", { name }),
    }[model.state] ?? name;
  reportState();
}

async function modelAction() {
  const path = model.state === "downloading" ? "/api/model/cancel" : "/api/model/download";
  try {
    await api(path, { method: "POST" });
  } catch (error) {
    $("modelText").textContent = error.message;
  }
}

$("modelAction").onclick = modelAction;
$("modelChip").onclick = () => openSettings("set-models");

// ───────── 받아쓰기 모델 목록 (설정) ─────────

const modelErrors = {};
const SOURCE_TEXT = { bundled: () => t("앱에 포함"), downloaded: () => t("내려받음"), handy: () => t("Handy 앱의 모델 사용") };

function fmtSize(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)}GB` : `${Math.round(bytes / 1e6)}MB`;
}
function fmtHourTime(rtf) {
  const sec = Math.round(rtf * 3600);
  if (sec < 60) return t("약 {n}초", { n: sec });
  const min = Math.floor(sec / 60);
  return sec % 60 >= 30 ? t("약 {n}분 30초", { n: min }) : t("약 {n}분", { n: min });
}

async function loadModelList() {
  let data;
  try {
    data = await api("/api/models");
  } catch (error) {
    $("modelList").textContent = error.message;
    return;
  }
  $("modelList").replaceChildren(...data.models.map(asrModelCard));
}

function asrModelCard(m) {
  const tags = [m.streaming ? ["blue", t("실시간 스트리밍 지원")] : ["", t("스트리밍 미지원 (문장 단위)")]];
  if (m.installed) tags.push(["", SOURCE_TEXT[m.source]?.() ?? t("설치됨")]);
  if (m.size > 1.2e9) tags.push(["warn", t("메모리 16GB 이상 권장")]);
  return modelCard(m, {
    sub: `${m.family} · ${fmtSize(m.size)} · ${m.languages} · ${t("1시간 녹음 처리 {time}", { time: fmtHourTime(m.rtf) })}`,
    tags,
    post: (action) => api(`/api/models/${m.id}/${action}`, { method: "POST" }),
    reload: loadModelList,
    canDelete: m.source === "downloaded",
  });
}

// voin 내장 요약 모델 목록: 받아쓰기 모델과 같은 카드, 이 맥 메모리에 맞는 모델에 "추천"
async function loadSummaryModelList() {
  let data;
  try {
    data = await api("/api/summary/local-models");
  } catch (error) {
    $("summaryModelList").textContent = error.message;
    return;
  }
  $("summaryModelList").replaceChildren(...data.models.map((m) => summaryModelCard(m, data.memoryGB)));
}

function summaryModelCard(m, memoryGB) {
  const tags = [["", m.license]];
  if (m.recommended) tags.unshift(["good", t("이 맥({gb}GB)에 추천", { gb: memoryGB })]);
  if (!m.fits) tags.push(["warn", t("메모리 {gb}GB 이상 필요", { gb: m.minMemoryGB })]);
  return modelCard(m, {
    sub: `${m.family} · ${fmtSize(m.size)} · ${t("무료 · 기록이 이 맥 밖으로 나가지 않음")}`,
    tags,
    post: (action) => api(`/api/summary/local-models/${m.id}/${action}`, { method: "POST" }),
    reload: loadSummaryModelList,
    canDelete: true,
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 모델 카드 (받아쓰기·요약 공통). tags: [[색 클래스, 글], …]
function modelCard(m, { sub, tags, post, reload, canDelete }) {
  const inUse = m.active && m.installed; // 고른 모델이라도 아직 받지 않았으면 "사용 중"이 아니다
  const card = el("article", `model-card${inUse ? " active" : ""}`);
  const top = el("div", "model-top");
  const info = el("div");
  info.append(el("div", "model-name", m.name), el("div", "model-sub", sub));
  const badges = el("div", "model-badges");
  if (inUse) badges.append(el("span", "tag blue", t("사용 중")));
  if (m.badge) badges.append(el("span", "tag good", m.badge));
  for (const [cls, text] of tags) badges.append(el("span", `tag${cls ? ` ${cls}` : ""}`, text));
  info.append(badges);

  const actions = el("div", "model-actions");
  const button = (label, onClick, cls) => {
    const b = el("button", cls, label);
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      delete modelErrors[m.id];
      try {
        await onClick();
      } catch (error) {
        modelErrors[m.id] = error.message;
      }
      reload();
    };
    return b;
  };
  if (m.downloading) actions.append(button(t("취소"), () => post("cancel")));
  else if (!m.installed) actions.append(button(m.partial ? t("이어 받기") : t("내려받기"), () => post("download"), "primary"));
  else if (!m.active) {
    actions.append(button(t("사용하기"), () => post("use"), "primary"));
    if (canDelete) actions.append(button(t("삭제"), () => post("delete")));
  }
  top.append(info, actions);
  card.append(top);

  if (m.downloading) {
    const p = el("div", "model-progress");
    const bar = el("progress");
    bar.max = 1;
    if (!m.downloading.verifying) bar.value = m.downloading.received / m.downloading.total;
    p.append(bar, el("span", null, m.downloading.verifying ? t("확인 중…") : `${Math.round(m.downloading.received / 1e6)} / ${Math.round(m.downloading.total / 1e6)}MB`));
    card.append(p);
  }
  if (modelErrors[m.id]) card.append(el("p", "model-error", modelErrors[m.id]));

  const pc = el("div", "model-proscons");
  for (const [title, items] of [[t("장점"), m.pros], [t("단점"), m.cons]]) {
    const col = el("div");
    const ul = el("ul");
    ul.append(...items.map((t) => el("li", null, t)));
    col.append(el("h4", null, title), ul);
    pc.append(col);
  }
  card.append(pc);
  return card;
}

// ───────── 녹음 ─────────

// ───────── 파형: 입력에 맞춰 움직이는 선 하나 ─────────
// 마이크는 브라우저의 AnalyserNode로 바로 그리고, 화상회의 소리는 서버가 보내는 크기로 아래에 옅게 더한다
function createWave(canvas) {
  const state = { analyser: null, buffer: null, system: 0, frame: null, phase: 0 };
  const color = () => getComputedStyle(document.body).getPropertyValue("--brand").trim() || "#5b5bd6";
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    // 쉬고 있을 때는 아무것도 그리지 않는다 (막대 가운데의 상황 글 위로 선이 지나가 보이지 않게)
    if (!state.analyser) {
      state.frame = null;
      return;
    }
    state.analyser.getFloatTimeDomainData(state.buffer);
    const n = state.buffer.length;
    let peak = 0;
    for (const v of state.buffer) peak = Math.max(peak, Math.abs(v));
    const gain = Math.min(6, 0.9 / Math.max(0.02, peak)); // 작은 소리도 보이게 키우되 조용할 땐 6배까지만
    ctx.strokeStyle = color();
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const i = Math.floor((x / w) * (n - 1));
      // 가장자리로 갈수록 잦아들게
      const edge = Math.sin((Math.PI * x) / w);
      const y = mid + state.buffer[i] * gain * mid * 0.85 * edge;
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    if (state.system > 0.002) {
      state.phase += 0.15;
      const amp = Math.min(1, state.system * 8) * mid * 0.6;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const edge = Math.sin((Math.PI * x) / w);
        const y = mid + Math.sin(x / 18 + state.phase) * amp * edge;
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    state.frame = requestAnimationFrame(draw);
  }
  return {
    attach(analyser) {
      state.analyser = analyser;
      state.buffer = new Float32Array(analyser.fftSize);
      if (!state.frame) draw();
    },
    detach() {
      state.analyser = null;
      state.system = 0;
      if (state.frame) cancelAnimationFrame(state.frame);
      state.frame = null;
      draw();
    },
    system(level) {
      state.system = level;
    },
    redraw: draw,
  };
}
const recordWave = createWave($("wave"));
const agentWave = recordWave; // 파형은 막대 가운데 하나를 녹음·작업이 함께 쓴다
window.addEventListener("resize", () => {
  recordWave.redraw();
});

function setLevel(source, level) {
  if (source !== "system") return;
  recordWave.system(level);
  if (level > 0.01) systemHeardAt = Date.now();
}

// 마이크를 16kHz로 열어 서버로 보내고, 파형용 분석기를 함께 돌려준다
async function openMic() {
  const deviceId = $("micSelect").value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule("mic-worklet.js");
  const node = new AudioWorkletNode(context, "mic-capture");
  node.port.onmessage = (event) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(event.data.buffer);
  };
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(node);
  source.connect(analyser);
  return { context, stream, node, analyser };
}

function closeMic(mic) {
  mic?.stream.getTracks().forEach((t) => t.stop());
  mic?.context.close();
}

// 녹음 중이 아닐 때의 버튼: 모델이 준비되어야 누를 수 있다
function setIdleButton() {
  const ready = model.state === "ready";
  setButton(ready ? t("녹음") : t("모델 준비 중"), !ready || ws?.readyState !== WebSocket.OPEN);
  $("workButton").disabled = !ready;
  $("importButton").disabled = !ready || recording;
}

function setButton(label, disabled) {
  $("toggle").setAttribute("aria-label", label);
  $("toggle").title = label;
  $("toggle").disabled = disabled;
  reportState();
}

async function startRecording() {
  showNotice(null);
  setButton(t("시작하는 중…"), true);
  try {
    if (dictating) stopDictation({ cancel: true });
    audio = await openMic();
    recordWave.attach(audio.analyser);
    refreshMicList();
  } catch (error) {
    setIdleButton();
    showNotice(
      t("마이크를 사용할 수 없습니다: {message}. 시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 권한을 확인하세요.", { message: error.message }),
    );
    return;
  }

  $("transcript").replaceChildren();
  ws.send(JSON.stringify({ type: "start", title: $("title").value, includeSystem: $("includeSystem").checked }));
  recording = true;
  queueMicrotask(refitPanel);
  setRecordingLock(true);
  $("timer").hidden = false;
  $("workButton").disabled = true;
  lastActivity = "record";
  if (!$("title").value.trim() && context?.app) $("title").value = t("{app} 회의", { app: context.app.name });
  $("toggle").classList.add("recording");
  renderBar();
  $("recordView").classList.add("recording-on");
  const startedAt = (recordingStartedAt = Date.now());
  setButton(t("녹음 중 · 누르면 끝"), false);
  timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $("timer").textContent = [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");
    if (!$("recordView").hidden) renderContextRow();
  }, 500);
}

function stopAudio() {
  recording = false;
  recordingStartedAt = null;
  clearInterval(timerHandle);
  closeMic(audio);
  audio = null;
  recordWave.detach();
  setRecordingLock(false);
  $("timer").hidden = true;
  $("timer").textContent = "00:00:00";
  $("workButton").disabled = model.state !== "ready";
  $("toggle").classList.remove("recording");
  renderBar();
  $("recordView").classList.remove("recording-on");
}

function stopRecording() {
  stopAudio();
  // 서버가 남은 말을 받아쓰고, 화자 분석 후 저장한 뒤 "stopped"를 보낸다
  setButton(t("저장하는 중…"), true);
  setJobStatus(t("저장하는 중…"));
  setProcessing(t("저장하는 중…"));
  ws.send(JSON.stringify({ type: "stop" }));
}

// 녹음 중에는 다른 화면으로 가지 않게 막는다
function setRecordingLock(locked) {
  for (const id of ["title", "micSelect", "includeSystem", "newMeeting", "importButton", "settingsButton"]) $(id).disabled = locked;
  document.querySelectorAll(".meeting-list button").forEach((b) => (b.disabled = locked));
}

async function refreshMicList() {
  const select = $("micSelect");
  const selected = select.value;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  select.replaceChildren(new Option(t("기본 마이크"), ""));
  for (const d of devices) {
    if (d.deviceId === "default" || !d.label) continue;
    select.append(new Option(d.label, d.deviceId));
  }
  select.value = selected;
}

// ───────── 파일 불러오기 ─────────

async function importFile(file) {
  if (recording) return;
  if (model.state !== "ready") {
    setJobStatus(t("받아쓰기 모델이 준비된 뒤에 불러올 수 있습니다."));
    return;
  }
  setJobStatus(t("'{name}' 올리는 중…", { name: file.name }));
  try {
    await api(`/api/import?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  } catch (error) {
    setJobStatus(t("불러오기 실패: {message}", { message: error.message }));
  }
}

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files") || recording) return;
  dragDepth++;
  $("dropOverlay").hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("dropOverlay").hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropOverlay").hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file && !recording) importFile(file);
});

// ───────── 회의록 목록과 보기 ─────────

let meetingItems = [];
let openFile = null;

async function loadMeetingList() {
  const { error, items } = await api("/api/meetings");
  // 경로는 보여 주지 않고, 저장 폴더에 문제가 있을 때만 알린다
  $("saveError").textContent = error ?? "";
  $("saveError").hidden = !error;
  meetingItems = items;
  renderMeetingList();
}

function dayLabel(date) {
  if (!date) return t("날짜 없음");
  const day = new Date(`${date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return t("오늘");
  if (diff === 1) return t("어제");
  const year = day.getFullYear() === today.getFullYear() ? undefined : "numeric";
  return day.toLocaleDateString(LOCALE, { year, month: "long", day: "numeric", weekday: "short" });
}

function renderMeetingList() {
  const query = $("searchInput").value.trim().toLowerCase();
  const items = meetingItems.filter((m) => !query || m.title.toLowerCase().includes(query));
  const list = $("meetingList");
  list.replaceChildren();
  $("emptyList").hidden = meetingItems.length > 0 || !$("saveError").hidden;
  if (query && !items.length) list.append(el("p", "empty-list", t("'{query}'와 맞는 기록이 없습니다.", { query })));
  let group = null;
  for (const m of items) {
    const label = dayLabel(m.date);
    if (group?.dataset.label !== label) {
      group = el("section", "list-group");
      group.dataset.label = label;
      group.append(el("h3", null, label));
      list.append(group);
    }
    const button = el("button");
    button.type = "button";
    button.dataset.file = m.file;
    button.disabled = recording;
    button.classList.toggle("active", m.file === openFile && !$("fileView").hidden);
    const meta = [m.start, m.duration, m.speakers ? t("{n}명", { n: m.speakers }) : null].filter(Boolean).join(" · ");
    button.append(el("span", "item-title", m.title), el("span", "item-meta", meta || " "));
    button.onclick = () => {
      openMeeting(m.file);
    };
    group.append(button);
  }
}

$("searchInput").oninput = renderMeetingList;

// 요약(정해진 모양의 Markdown)을 화면에 그린다. 글은 모두 textContent로 넣는다.
// Obsidian 링크 [[노트|보이는 글]]는 화면에서 보이는 글만, 연결된 낱말임을 밑줄로 표시한다
function withLinks(tag, className, text) {
  const node = el(tag, className);
  let last = 0;
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    node.append(text.slice(last, m.index));
    const link = el("span", "wikilink", m[2] ?? m[1]);
    link.title = t("Obsidian 노트: {name}", { name: m[1] });
    node.append(link);
    last = m.index + m[0].length;
  }
  node.append(text.slice(last));
  return node;
}

function summaryCard(lines) {
  const card = el("section", "summary-card");
  card.setAttribute("aria-label", t("요약"));
  let list = null;
  for (const line of lines) {
    if (line.startsWith("- ")) {
      list ??= card.appendChild(el("ul"));
      const todo = line.match(/^- \[[ xX]\] (.*)$/);
      list.append(withLinks("li", todo ? "todo" : null, todo ? todo[1] : line.slice(2)));
      continue;
    }
    list = null;
    if (line.startsWith("> ")) card.append(withLinks("blockquote", null, line.slice(2)));
    else if (line.startsWith("### ")) card.append(el("h3", null, line.slice(4)));
    else if (/^\*.*\*$/.test(line)) card.append(el("p", "summary-by", line.slice(1, -1)));
    else card.append(withLinks("p", null, line));
  }
  return card;
}

const summarizingFiles = new Set();

// ───────── 참석자 이름 붙이기 ─────────
// 화자마다 카드: 이름 칸, 목소리 듣기, 말한 시간·비율, 대표 발언(누르면 그 위치로). 이름을 모두 붙이면 접힌다.

const UNNAMED_SPEAKER = /^(화자|원격) \d+$/;
const toSeconds = (t) => t.split(":").reduce((acc, n) => acc * 60 + Number(n), 0);
let speakerPanelOpen = null; // 사용자가 접거나 편 상태 (null = 자동)
const voicePlayer = new Audio();
let playingButton = null;

function stopVoice() {
  voicePlayer.pause();
  voicePlayer.onended = null;
  if (playingButton) playingButton.textContent = t("▶ 목소리");
  playingButton = null;
}

// 조각들을 차례로 재생한다. 재생 중에 다시 누르면 멈춘다
function playVoices(button, urls) {
  const wasPlaying = playingButton === button;
  stopVoice();
  if (wasPlaying) return;
  playingButton = button;
  button.textContent = t("■ 멈춤");
  let i = 0;
  const next = () => {
    if (i >= urls.length) return stopVoice();
    voicePlayer.src = urls[i++];
    voicePlayer.play().catch(stopVoice);
  };
  voicePlayer.onended = next;
  next();
}

function speakerStats(lines) {
  // 줄마다 다음 줄까지를 말한 시간으로 본다 (한 줄 최대 60초)
  const stats = new Map();
  lines.forEach((l, i) => {
    const start = toSeconds(l.time);
    const end = i + 1 < lines.length ? toSeconds(lines[i + 1].time) : start + 5;
    const s = stats.get(l.label) ?? { label: l.label, seconds: 0, count: 0, lines: [] };
    s.seconds += Math.min(60, Math.max(1, end - start));
    s.count += 1;
    s.lines.push(l);
    stats.set(l.label, s);
  });
  return [...stats.values()].sort((a, b) => b.seconds - a.seconds);
}

function jumpToLine(time) {
  const target = $("fileBody").querySelector(`p[data-time="${time}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1600);
}

function renderSpeakerCards(file, lines, voices, suggestions = {}) {
  stopVoice();
  const stats = speakerStats(lines);
  const total = stats.reduce((sum, s) => sum + s.seconds, 0) || 1;
  const unnamed = stats.filter((s) => UNNAMED_SPEAKER.test(s.label)).length;
  $("speakerPanel").hidden = stats.length === 0;
  const open = speakerPanelOpen ?? unnamed > 0;
  $("speakerInputs").hidden = !open;
  $("speakerToggle").textContent = open ? t("접기") : t("이름 바꾸기");
  $("speakerToggle").onclick = () => {
    speakerPanelOpen = !open;
    renderSpeakerCards(file, lines, voices, suggestions);
  };
  // 이름 없는 화자가 있고 추천이 아직 없으면, 요약 도구에 이름 후보를 물어볼 수 있다
  const askButton = $("speakerAsk");
  askButton.hidden = !open || !unnamed || Object.keys(suggestions).length > 0;
  askButton.disabled = summarizingFiles.has(file);
  askButton.onclick = async () => {
    askButton.disabled = true;
    try {
      await api(`/api/meetings/${encodeURIComponent(file)}/suggest-names`, { method: "POST" });
      summarizingFiles.add(file);
    } catch (error) {
      setJobStatus(error.message);
      askButton.disabled = false;
    }
  };
  $("speakerHint").textContent = !open
    ? stats.map((s) => s.label).join(", ")
    : unnamed
      ? t("{n}명에게 이름이 없습니다. ▶로 목소리를 듣거나 대표 발언을 보고 이름을 넣으세요.", { n: unnamed })
      : t("이름을 고치면 기록·요약·참석자 링크가 함께 바뀝니다.");

  $("speakerInputs").replaceChildren(
    ...stats.map((s) => {
      const card = el("div", "speaker-card");
      card.style.setProperty("--h", hueOf(s.label));
      card.dataset.label = s.label;
      const head = el("div", "sc-head");
      const input = el("input");
      input.type = "text";
      input.value = s.label;
      input.placeholder = t("이름");
      input.setAttribute("aria-label", t("{label} 이름", { label: s.label }));
      if (UNNAMED_SPEAKER.test(s.label)) {
        input.value = "";
        input.placeholder = t("{label} → 이름 입력", { label: s.label });
      }
      const commit = async () => {
        const to = input.value.trim();
        if (!to || to === s.label) return (input.value = UNNAMED_SPEAKER.test(s.label) ? "" : s.label);
        try {
          await api(`/api/meetings/${encodeURIComponent(file)}/rename`, { method: "POST", body: JSON.stringify({ from: s.label, to }) });
          await openMeeting(file);
          // 다음 이름 없는 화자 칸으로
          [...document.querySelectorAll(".speaker-card input")].find((i) => !i.value)?.focus();
        } catch (error) {
          setJobStatus(error.message);
        }
      };
      input.onkeydown = (e) => e.key === "Enter" && input.blur();
      input.onblur = commit;
      head.append(el("span", "sc-dot"), input);
      const urls = voices[s.label] ?? [];
      if (urls.length) {
        const play = el("button", "sc-play", t("▶ 목소리"));
        play.type = "button";
        play.title = t("{label}의 목소리 {n}개 듣기", { label: s.label, n: urls.length });
        play.onclick = () => playVoices(play, urls);
        head.append(play);
      }
      const share = Math.round((s.seconds / total) * 100);
      const minutes = s.seconds >= 60 ? t("약 {n}분", { n: Math.round(s.seconds / 60) }) : t("약 {n}초", { n: Math.round(s.seconds) });
      const bar = el("div", "sc-bar");
      const fill = el("span");
      fill.style.width = `${share}%`;
      bar.append(fill);
      const quotes = el("ul", "sc-quotes");
      for (const l of [...s.lines].sort((a, b) => b.text.length - a.text.length).slice(0, 2).sort((a, b) => toSeconds(a.time) - toSeconds(b.time))) {
        const li = el("li");
        const b = el("button");
        b.type = "button";
        b.title = t("기록에서 이 발언 위치로 이동");
        const clip = (t) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);
        const said = el("span", null, `“${clip(l.text)}”`);
        // 외국어 발언은 번역도 함께 (정리할 때 붙인 "↳ 번역" 줄)
        if (l.translation) said.append(el("span", "sc-translation", `↳ ${clip(l.translation)}`));
        b.append(said, el("time", null, l.time));
        b.onclick = () => jumpToLine(l.time);
        li.append(b);
        quotes.append(li);
      }
      card.append(head);
      // AI가 찾은 이름 후보: 누르면 그 이름으로 바꾼다
      const hint = suggestions[s.label];
      if (hint && UNNAMED_SPEAKER.test(s.label)) {
        const chip = el("button", "sc-suggest");
        chip.type = "button";
        chip.append(el("span", "sc-suggest-name", t("추천: {name}", { name: hint.name })), el("span", "sc-suggest-why", hint.reason));
        chip.title = t("누르면 이 이름으로 바꿉니다");
        chip.onclick = () => {
          input.value = hint.name;
          commit();
        };
        card.append(chip);
      }
      card.append(el("div", "sc-stats", `${minutes} · ${share}% · ${t("{n}번 말함", { n: s.count })}`), bar, quotes);
      return card;
    }),
  );
}

// 본문의 화자 이름을 누르면 그 화자의 이름 칸으로
$("fileBody").addEventListener("click", (e) => {
  const name = e.target.closest(".speaker");
  if (!name) return;
  const label = name.textContent;
  if ($("speakerInputs").hidden) {
    speakerPanelOpen = true;
    return openMeeting(openFile).then(() => focusSpeaker(label));
  }
  focusSpeaker(label);
});
function focusSpeaker(label) {
  const card = [...document.querySelectorAll(".speaker-card")].find((c) => c.dataset.label === label);
  card?.scrollIntoView({ block: "nearest" });
  card?.querySelector("input")?.focus();
}

// Markdown 회의록을 화면용 정보로 나눈다 (Obsidian 속성 블록 포함)
function parseMeeting(text) {
  const result = { title: "", props: {}, meta: [], lines: [], audio: [], summary: [] };
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    body = text.slice(fm[0].length);
    let listKey = null;
    for (const row of fm[1].split("\n")) {
      const item = row.match(/^\s+- (.*)$/);
      if (item && listKey) {
        result.props[listKey].push(item[1].replace(/^"|"$/g, ""));
        continue;
      }
      const kv = row.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      listKey = kv[2] === "" ? kv[1] : null;
      result.props[kv[1]] = kv[2] === "" ? [] : kv[2].replace(/^"|"$/g, "");
    }
  }
  let section = null; // null | "summary" | "audio"
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    if (line.startsWith("# ")) result.title = line.slice(2);
    else if (line === "## 요약") section = "summary";
    else if (line === "## 녹음") section = "audio";
    else if (line.startsWith("## ")) section = null;
    else if (section === "summary") result.summary.push(line);
    else if (section === "audio") result.audio.push(line.replace(/^!\[\[|\]\]$|^- \[|\]\(.*\)$/g, ""));
    else {
      const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\] \*\*(.+?)\*\*: (.*)$/);
      if (m) result.lines.push({ time: m[1], label: m[2], text: m[3] });
      else if (line.startsWith("↳ ") && result.lines.length) result.lines.at(-1).translation = line.slice(2);
      else result.meta.push(line.replace(/^- /, ""));
    }
  }
  return result;
}

async function openMeeting(file) {
  let data;
  try {
    data = await api(`/api/meetings/${encodeURIComponent(file)}`);
  } catch (error) {
    setJobStatus(error.message);
    return;
  }
  const meeting = parseMeeting(data.content);
  if (openFile !== file) speakerPanelOpen = null; // 다른 기록을 열면 접힘 상태를 다시 자동으로
  openFile = file;
  document.querySelectorAll(".meeting-list button").forEach((b) => b.classList.toggle("active", b.dataset.file === file));

  $("fileTitle").textContent = meeting.title || file;
  const p = meeting.props;
  const metaParts = p.date
    ? [`${dayLabel(p.date)} ${p.start ?? ""}${p.end ? `–${p.end}` : ""}`, p.duration, p.participants?.length ? t("참석자 {n}명", { n: p.participants.length }) : null, p.source]
    : meeting.meta;
  $("fileMeta").replaceChildren(...metaParts.filter(Boolean).map((t) => el("span", null, t)));

  const body = $("fileBody");
  body.replaceChildren();
  if (meeting.summary.length) body.append(summaryCard(meeting.summary), el("h2", "transcript-heading", t("기록")));
  for (const l of meeting.lines) addLine(body, l.time, l.label, l.text, l.translation);
  if (!meeting.lines.length) body.append(el("p", "placeholder-text", t("받아쓴 내용이 없습니다.")));
  if (meeting.audio.length) {
    const note = document.createElement("p");
    note.className = "muted small";
    note.textContent = t("보관된 음성 파일: {files} (Finder에서 보기 → 첨부 폴더)", { files: meeting.audio.join(", ") });
    body.append(note);
  }

  renderSpeakerCards(file, meeting.lines, data.voices ?? {}, data.suggestions ?? {});

  $("copyFile").onclick = async () => {
    await navigator.clipboard.writeText(data.content);
    $("copyFile").querySelector("span").textContent = t("복사됨");
    setTimeout(() => ($("copyFile").querySelector("span").textContent = t("복사")), 1500);
  };
  $("summarizeFile").querySelector("span").textContent = meeting.summary.length ? t("다시 요약") : t("요약 만들기");
  $("summarizeFile").disabled = summarizingFiles.has(file) || !meeting.lines.length;
  $("summarizeFile").onclick = async () => {
    $("summarizeFile").disabled = true;
    try {
      await api(`/api/meetings/${encodeURIComponent(file)}/summarize`, { method: "POST" });
      summarizingFiles.add(file);
    } catch (error) {
      setJobStatus(error.message);
      $("summarizeFile").disabled = false;
    }
  };
  $("revealFile").onclick = () => api(`/api/meetings/${encodeURIComponent(file)}/reveal`, { method: "POST" });
  $("obsidianLink").hidden = !data.obsidianUrl;
  if (data.obsidianUrl) $("obsidianLink").href = data.obsidianUrl;
  showView("fileView");
}

// ───────── 설정 ─────────

const form = $("settingsForm");

let vaultCount = 0;

function fillSettingsForm({ settings: s, vaults, diarizationReady, appVersion, saveDir }) {
  vaultCount = vaults.length;
  $("appVersion").textContent = appVersion;
  $("saveDirText").textContent = saveDir ?? "";
  renderHotkey(s.hotkey);
  if (typeof renderAgentHotkey === "function") renderAgentHotkey();
  if (typeof renderDictationHotkey === "function") renderDictationHotkey();
  $("dictionaryText").value = dictionaryToText(s.dictionary);
  const vaultSelect = $("vaultSelect");
  vaultSelect.replaceChildren(
    ...vaults.map((v) => Object.assign(new Option(`${v.name}${v.open ? t(" · 지금 열려 있음") : ""}`, v.path), { title: v.path })),
  );
  if (s.obsidianVault && !vaults.some((v) => v.path === s.obsidianVault)) {
    vaultSelect.append(new Option(t("{vault} (찾을 수 없음)", { vault: s.obsidianVault }), s.obsidianVault));
  }
  $("speakerCount").replaceChildren(
    new Option(t("자동 (권장)"), "0"),
    ...Array.from({ length: 19 }, (_, i) => new Option(t("{n}명", { n: i + 2 }), String(i + 2))),
  );
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === "radio") el.checked = el.value === s[el.name];
    else if (el.type === "checkbox") el.checked = s[el.name];
    else el.value = s[el.name];
  }
  if (!s.obsidianVault && vaults.length) vaultSelect.value = vaults[0].path;
  $("diarizationMissing").hidden = diarizationReady;
  updateSettingsUi();
}

function updateSettingsUi() {
  const mode = form.elements.saveMode.value;
  form.querySelectorAll("[data-show]").forEach((el) => (el.hidden = el.dataset.show !== mode));
  $("noVaults").hidden = mode !== "obsidian" || vaultCount > 0;
  form.querySelectorAll("[data-mac-only]").forEach((el) => (el.hidden = !isMacApp));
  $("browserNote").hidden = isMacApp;
  $("silenceValue").textContent = t("{n}초", { n: (form.elements.silenceMs.value / 1000).toFixed(1) });
  form.elements.expectedSpeakers.disabled = !form.elements.diarization.checked;
  form.querySelectorAll(".pick").forEach((b) => (b.hidden = !isMacApp));
}

let savedTimer = null;
async function saveSettingsForm() {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || (el.type === "radio" && !el.checked)) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  try {
    ({ settings } = await api("/api/settings", { method: "POST", body: JSON.stringify(data) }));
    $("savedBadge").textContent = t("저장됨");
    $("savedBadge").hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($("savedBadge").hidden = true), 1500);
    if (!recording) $("includeSystem").checked = settings.includeSystemDefault;
    tellNative({ type: "menuBarIcon", visible: settings.menuBarIcon });
    renderAgentTarget();
    api("/api/settings").then((d) => ($("saveDirText").textContent = d.saveDir ?? ""));
    loadMeetingList();
  } catch (error) {
    $("savedBadge").textContent = t("저장 실패: {message}", { message: error.message });
    $("savedBadge").hidden = false;
  }
}

form.addEventListener("input", (e) => {
  updateSettingsUi();
  // 글자 입력란은 다 쓴 뒤(change) 저장하고, 나머지는 바로 저장
  if (e.target.type !== "text") saveSettingsForm();
});
form.addEventListener("change", (e) => e.target.type === "text" && saveSettingsForm());
form.addEventListener("submit", (e) => e.preventDefault());

// 맥 앱에서는 폴더 선택 창을 띄울 수 있다 (앱이 folderPicked를 불러 준다)
form.querySelectorAll(".pick").forEach((button) => {
  button.onclick = () => window.webkit.messageHandlers.pickFolder.postMessage(button.dataset.target);
});
window.folderPicked = (target, path) => {
  if (target === "agentFolderAdd") return chooseFolder(path, { add: true });
  form.elements[target].value = path;
  saveSettingsForm();
};

// 요약 방법 목록: 명령줄 도구·Ollama·API 키별로 상태와 설정을 그린다
async function renderAgentToolHint(providers) {
  const find = (id) => providers.find((p) => p.id === id);
  const line = (id, name) => `${name}: ${find(id)?.ready ? t("준비됨") : find(id)?.installed ? t("로그인 필요") : t("설치 안 됨")}`;
  $("agentToolHint").textContent = `${line("codex", "Codex")} · ${line("claude", "Claude Code")}`;
}

async function loadProviders(refresh = false) {
  const groups = { cli: $("providerCli"), login: $("providerLogin"), local: $("providerLocal"), api: $("providerApi") };
  if (refresh) Object.values(groups).forEach((g) => g.replaceChildren(el("div", "provider-row", t("확인하는 중…"))));
  let providers;
  try {
    ({ providers } = await api(`/api/summary/providers${refresh ? "?refresh" : ""}`));
  } catch (error) {
    groups.cli.replaceChildren(el("div", "provider-row", error.message));
    return;
  }
  // 요약 방법 고르기
  const select = $("summaryProviderSelect");
  select.replaceChildren(
    new Option(t("자동"), "auto"),
    ...providers.map((p) => new Option(`${p.name}${p.ready ? "" : t(" (준비 안 됨)")}`, p.id)),
    new Option(t("끄기 (요약하지 않음)"), "off"),
  );
  select.value = settings.summaryProvider;
  Object.values(groups).forEach((g) => g.replaceChildren());
  for (const p of providers) groups[p.kind === "builtin" ? "local" : p.kind].append(providerRow(p));
  loadSummaryModelList();
  renderAgentToolHint(providers);
}

function providerRow(p) {
  const row = el("div", "provider-row");
  const top = el("div", "row-top");
  const text = el("div", "row-text");
  text.append(el("span", "row-title", p.name), el("span", "hint", p.company));
  top.append(text, el("span", `provider-status${p.ready ? " ok" : ""}`, p.status));
  row.append(top);
  const controls = el("div", "provider-controls");
  const error = el("p", "provider-error");
  error.hidden = true;
  let after = null; // 컨트롤 아래에 붙일 것 (로그인 코드 상자)
  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  // 모델 고르기 (API·Ollama)
  const modelSelect = () => {
    const sel = el("select");
    sel.setAttribute("aria-label", t("{name} 모델", { name: p.name }));
    const current = settings.summaryModels?.[p.id] ?? "";
    const auto = p.choice?.auto && p.choice.model ? t("자동 (지금: {model})", { model: p.choice.model }) : t("자동으로 고름");
    sel.append(new Option(p.id === "claude" ? t("Claude Code 기본") : auto, ""));
    // 받아 둔 목록 기준: 고른 모델보다 새 모델이 있거나, 고른 모델이 없어졌으면 알린다
    if (p.choice?.newer) fail(t("새 모델이 있습니다: {model} (자동으로 두면 새 모델을 씁니다)", { model: p.choice.newer }));
    if (p.choice?.retired) fail(t("고른 모델({retired})을 더 쓸 수 없어 {model}로 대신 요약합니다.", { retired: p.choice.retired, model: p.choice.model }));
    if (current) sel.append(new Option(current, current));
    sel.value = current;
    sel.onchange = () => saveSummaryModel(p.id, sel.value);
    const load = el("button", null, t("모델 불러오기"));
    load.type = "button";
    load.onclick = async () => {
      load.disabled = true;
      error.hidden = true;
      try {
        const { models } = await api(`/api/summary/models?id=${p.id}`);
        const keep = sel.value;
        sel.replaceChildren(sel.options[0], ...models.map((m) => new Option(m, m)));
        sel.value = models.includes(keep) ? keep : "";
      } catch (e) {
        fail(e.message);
      } finally {
        load.disabled = false;
      }
    };
    return [sel, load];
  };

  if (p.id === "claude" && p.ready) controls.append(...modelSelect());
  if (p.kind === "api") {
    if (p.id === "custom") {
      const url = el("input");
      url.type = "text";
      url.name = "summaryCustomUrl";
      url.placeholder = "http://localhost:1234/v1";
      url.value = settings.summaryCustomUrl ?? "";
      url.setAttribute("aria-label", t("OpenAI 호환 서버 주소"));
      controls.append(url);
    }
    const key = el("input");
    key.type = "password";
    key.placeholder = p.hasKey ? t("등록됨 — 바꾸려면 새 키 입력") : p.id === "custom" ? t("API 키 (필요할 때만)") : t("API 키");
    key.autocomplete = "off";
    key.setAttribute("aria-label", t("{name} 키", { name: p.name }));
    const save = el("button", "primary", t("저장"));
    save.type = "button";
    save.onclick = async () => {
      if (!key.value.trim()) return fail(t("키를 입력하세요."));
      save.disabled = true;
      try {
        await api("/api/summary/key", { method: "POST", body: JSON.stringify({ id: p.id, key: key.value }) });
        loadProviders(true);
      } catch (e) {
        fail(e.message);
        save.disabled = false;
      }
    };
    controls.append(key, save);
    if (p.hasKey) {
      const remove = el("button", null, t("키 삭제"));
      remove.type = "button";
      remove.onclick = async () => {
        await api("/api/summary/key", { method: "POST", body: JSON.stringify({ id: p.id, key: "" }) });
        loadProviders(true);
      };
      controls.append(remove);
    }
    if (p.hasKey || p.id === "custom") controls.append(...modelSelect());
    if (p.keyUrl) {
      const link = el("a", null, t("키 만들기"));
      link.href = p.keyUrl;
      link.target = "_blank";
      controls.append(link);
    }
  } else if (p.kind === "login") {
    if (p.loggedIn) {
      const out = el("button", null, t("로그아웃"));
      out.type = "button";
      out.onclick = async () => {
        await api(`/api/summary/login/${p.id}/logout`, { method: "POST" });
        loadProviders(true);
      };
      controls.append(out, ...modelSelect());
    } else {
      const start = el("button", "primary", t("로그인"));
      start.type = "button";
      const box = el("div", "login-box");
      box.hidden = true;
      start.onclick = async () => {
        start.disabled = true;
        error.hidden = true;
        try {
          const login = await api(`/api/summary/login/${p.id}/start`, { method: "POST" });
          const reopen = el("a", null, t("주소 다시 열기"));
          reopen.href = login.url;
          reopen.target = "_blank";
          const cancel = el("button", null, t("취소"));
          cancel.type = "button";
          cancel.onclick = async () => {
            await api(`/api/summary/login/${p.id}/cancel`, { method: "POST" });
            loadProviders(true);
          };
          box.replaceChildren(el("span", null, t("브라우저에서 이 코드를 입력하고 승인하세요:")), el("code", "login-code", login.userCode), reopen, cancel);
          box.hidden = false;
        } catch (e) {
          fail(e.message);
          start.disabled = false;
        }
      };
      controls.append(start);
      after = box;
    }
  } else if (p.kind === "local") {
    if (p.installed) controls.append(...modelSelect());
    else {
      const link = el("a", null, t("Ollama 내려받기"));
      link.href = p.keyUrl;
      link.target = "_blank";
      controls.append(link);
    }
  }
  if (controls.childElementCount) row.append(controls);
  if (after) row.append(after);
  row.append(error);
  return row;
}

async function saveSummaryModel(id, model) {
  ({ settings } = await api("/api/settings", { method: "POST", body: JSON.stringify({ summaryModels: { [id]: model } }) }));
}

$("recheckProviders").onclick = () => loadProviders(true);

// 처음 실행처럼 쓸 모델이 없으면 설정부터 연다: 받아쓰기 모델이 없으면 모델 목록, 받아쓰기는 되는데
// 요약 방법이 준비되지 않았으면 요약 설정으로 (앱을 켤 때마다 한 번씩만)
let setupStep = null; // null | "asr" | "summary" | "done"
async function guideSetup() {
  if (recording || dictating || setupStep === "summary" || setupStep === "done") return;
  if (model.state === "missing") {
    if (setupStep !== "asr") openSettings("set-models");
    setupStep = "asr";
    return;
  }
  if (model.state !== "ready") return;
  const { providers } = await api("/api/summary/providers");
  const wanted = settings.summaryProvider;
  const ready = wanted === "off" || (wanted === "auto" ? providers.some((p) => p.ready) : providers.find((p) => p.id === wanted)?.ready);
  setupStep = ready ? "done" : "summary";
  if (!ready) openSettings("set-summary");
}

async function openSettings(section) {
  if (recording) return;
  fillSettingsForm(await api("/api/settings"));
  showView("settingsView");
  loadModelList();
  loadProviders();
  showSettingsPage(typeof section === "string" ? section : null);
}

$("openSaveDir").onclick = () => api("/api/open-folder", { method: "POST" }).catch((e) => ($("saveDirText").textContent = e.message));
$("revealLog").onclick = () => api("/api/reveal-log", { method: "POST" });

// 설정은 첫 화면(앱 아이콘 모양 버튼)에서 항목을 골라 그 항목 화면만 본다. page가 없으면 첫 화면
function showSettingsPage(page) {
  $("settingsHome").hidden = Boolean(page);
  form.hidden = !page;
  for (const section of form.querySelectorAll(":scope > section")) section.hidden = section.id !== page;
  form.scrollTop = 0;
}
for (const tile of document.querySelectorAll(".settings-tile")) tile.onclick = () => showSettingsPage(tile.dataset.page);
$("settingsBack").onclick = () => showSettingsPage(null);

// ───────── 녹음 시작/중지 단축키 ─────────
// 저장 형식: "ctrl+alt+shift+cmd+KeyR" (수식키 순서 고정 + KeyboardEvent.code)

const MOD_SYMBOLS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const SUPPORTED_KEY = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Space)$/;

function hotkeyLabel(hotkey) {
  if (!hotkey) return t("사용 안 함");
  const parts = hotkey.split("+");
  const code = parts.pop();
  return parts.map((m) => MOD_SYMBOLS[m]).join("") + code.replace(/^Key|^Digit/, "");
}

function renderHotkey(hotkey) {
  $("hotkeyButton").textContent = hotkeyLabel(hotkey);
  $("hotkeyButton").classList.remove("listening");
  $("hotkeyClear").hidden = !hotkey;
}

let listeningHotkey = false;
$("hotkeyButton").onclick = () => {
  listeningHotkey = true;
  $("hotkeyButton").textContent = t("키 조합을 누르세요…");
  $("hotkeyButton").classList.add("listening");
  $("hotkeyError").hidden = true;
};
function stopListening() {
  listeningHotkey = false;
  renderHotkey(settings.hotkey);
}
$("hotkeyButton").onblur = () => listeningHotkey && stopListening();
$("hotkeyButton").addEventListener("keydown", (e) => {
  if (!listeningHotkey) return;
  e.preventDefault();
  if (e.key === "Escape") return stopListening();
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "cmd"].filter(Boolean);
  const error = !SUPPORTED_KEY.test(e.code)
    ? t("영문자, 숫자, F1~F12, Space 키만 쓸 수 있습니다.")
    : !mods.some((m) => m !== "shift")
      ? t("다른 앱과 겹치지 않도록 ⌘·⌥·⌃ 중 하나 이상을 함께 누르세요.")
      : null;
  if (error) {
    $("hotkeyError").textContent = error;
    $("hotkeyError").hidden = false;
    return;
  }
  listeningHotkey = false;
  saveHotkey([...mods, e.code].join("+"));
});
$("hotkeyClear").onclick = () => saveHotkey("");

async function saveHotkey(hotkey) {
  ({ settings } = await api("/api/settings", { method: "POST", body: JSON.stringify({ hotkey }) }));
  renderHotkey(settings.hotkey);
  renderShortcutHint();
  tellNative({ type: "hotkey", hotkey: settings.hotkey });
}

// 음성 작업 말하기 단축키 (⌥V): 같은 입력 방식, 저장 키만 다르다
let listeningAgentKey = false;
function renderAgentHotkey() {
  $("agentHotkeyButton").textContent = hotkeyLabel(settings?.agentHotkey);
  $("agentHotkeyButton").classList.remove("listening");
}
$("agentHotkeyButton").onclick = () => {
  listeningAgentKey = true;
  $("agentHotkeyButton").textContent = t("키 조합을 누르세요…");
  $("agentHotkeyButton").classList.add("listening");
};
$("agentHotkeyButton").onblur = () => {
  listeningAgentKey = false;
  renderAgentHotkey();
};
$("agentHotkeyButton").addEventListener("keydown", async (e) => {
  if (!listeningAgentKey) return;
  e.preventDefault();
  if (e.key === "Escape") return $("agentHotkeyButton").blur();
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "cmd"].filter(Boolean);
  if (!SUPPORTED_KEY.test(e.code) || !mods.some((m) => m !== "shift")) return;
  listeningAgentKey = false;
  ({ settings } = await api("/api/settings", { method: "POST", body: JSON.stringify({ agentHotkey: [...mods, e.code].join("+") }) }));
  renderAgentHotkey();
  renderAgentTarget();
  renderShortcutHint();
  tellNative({ type: "hotkey2", hotkey: settings.agentHotkey });
});

// 받아쓰기 단축키 (⌥D): 같은 입력 방식
let listeningDictationKey = false;
function renderDictationHotkey() {
  $("dictationHotkeyButton").textContent = hotkeyLabel(settings?.dictationHotkey) || t("없음");
  $("dictationHotkeyButton").classList.remove("listening");
}
$("dictationHotkeyButton").onclick = () => {
  listeningDictationKey = true;
  $("dictationHotkeyButton").textContent = t("키 조합을 누르세요…");
  $("dictationHotkeyButton").classList.add("listening");
};
$("dictationHotkeyButton").onblur = () => {
  listeningDictationKey = false;
  renderDictationHotkey();
};
$("dictationHotkeyButton").addEventListener("keydown", async (e) => {
  if (!listeningDictationKey) return;
  e.preventDefault();
  if (e.key === "Escape") return $("dictationHotkeyButton").blur();
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "cmd"].filter(Boolean);
  if (!SUPPORTED_KEY.test(e.code) || !mods.some((m) => m !== "shift")) return;
  listeningDictationKey = false;
  ({ settings } = await api("/api/settings", { method: "POST", body: JSON.stringify({ dictationHotkey: [...mods, e.code].join("+") }) }));
  renderDictationHotkey();
  tellNative({ type: "hotkey3", hotkey: settings.dictationHotkey });
});

// 용어 사전: 한 줄에 하나 "틀리게 들리는 말 => 바른 말". 글상자를 다 쓰고 나가면(change) 저장
$("dictionaryText").addEventListener("change", async (e) => {
  e.stopPropagation(); // 설정 폼 일반 저장과 따로 (사전은 배열이라)
  try {
    ({ settings } = await api("/api/settings", { method: "POST", body: JSON.stringify({ dictionary: parseDictionaryText(e.target.value) }) }));
    e.target.value = dictionaryToText(settings.dictionary);
    $("savedBadge").textContent = t("저장됨");
    $("savedBadge").hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($("savedBadge").hidden = true), 1500);
  } catch (error) {
    $("savedBadge").textContent = t("저장 실패: {message}", { message: error.message });
    $("savedBadge").hidden = false;
  }
});
$("dictionaryText").addEventListener("input", (e) => e.stopPropagation());

// 맥 앱이 단축키 등록 결과를 알려 준다 (다른 앱이 이미 쓰는 조합이면 실패)
window.hotkeyResult = (ok, message) => {
  $("hotkeyError").textContent = ok ? "" : message;
  $("hotkeyError").hidden = ok;
};


// ───────── 막대: 버튼과 가운데 상태 ─────────
// 가운데는 상황에 맞춰 하나만 보여 준다: 녹음·듣기 중이면 파형, 작업 중이면 진행, 평소엔 지금 상황(마이크·출력·회의 앱)

let lastActivity = "record"; // 💬가 열 판: 마지막으로 한 일
let context = null; // /api/context: { input, output, app }
let systemHeardAt = 0; // 화상회의(상대방) 소리가 마지막으로 들린 때
let barNote = null; // 잠깐 보여 줄 글 (작업 답의 첫 문장 등)

async function refreshContext() {
  try {
    context = await api("/api/context");
  } catch {
    return;
  }
  renderBar();
  renderContextRow();
}

// 스피커 경고는 상대방 소리를 함께 받을 때(회의 앱이 켜졌거나 "화상회의 소리 포함")만 의미가 있다: 그때만 경고로 보인다
function contextBits() {
  const bits = [];
  if (context?.app) bits.push({ text: context.app.inMeeting ? t("{app} 회의 중", { app: context.app.name }) : t("{app} 켜짐", { app: context.app.name }), kind: "brand" });
  const echoRisk = context?.app || $("includeSystem").checked;
  if (context?.output?.speaker && echoRisk) bits.push({ text: t("스피커 소리가 다시 녹음될 수 있어요 · 이어폰 권장"), kind: "warn" });
  else if (context?.output) bits.push({ text: context.output.name, kind: "", icon: "headphones" });
  if (context?.input) bits.push({ text: context.input.name, kind: "", icon: "mic" });
  return bits;
}

const ICONS = {
  mic: '<path d="M10 2.5a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5z"/><path d="M5 9.5a5 5 0 0 0 10 0M10 14.5v3"/>',
  headphones: '<path d="M3.5 13v-2.5a6.5 6.5 0 0 1 13 0V13"/><rect x="3" y="12" width="3.5" height="5" rx="1.2"/><rect x="13.5" y="12" width="3.5" height="5" rx="1.2"/>',
};
function chip(b) {
  const span = el("span", `ctx ${b.kind}`);
  const symbol = b.icon && sfSymbols[`${b.icon === "mic" ? "mic" : "headphones"}@11`];
  if (symbol) span.append(sfIcon(symbol));
  else if (b.icon) span.insertAdjacentHTML("beforeend", `<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[b.icon]}</svg>`);
  span.append(b.text);
  return span;
}

function renderContextRow() {
  const row = $("contextRow");
  const bits = contextBits();
  if (recording && Date.now() - systemHeardAt < 2500) bits.unshift({ text: t("상대방 소리 들림"), kind: "brand live" });
  row.replaceChildren(...bits.map(chip));
}

function renderBar() {
  const center = $("barCenter");
  const text = $("barText");
  // 대화 모드: 파형 위에 들은 말 → 작업 진행·답 → "말하세요" 순으로 한 줄
  center.classList.toggle("talk", dictating);
  if (dictating) {
    center.classList.remove("active");
    text.classList.toggle("heard", Boolean(heardText));
    if (heardText) return text.replaceChildren(heardText);
    text.replaceChildren();
    return text.append(el("span", "dot brand"), barNote ?? listenHint);
  }
  const active = recording;
  center.classList.toggle("active", active && !text.classList.contains("heard"));
  if (active) return;
  text.classList.remove("heard");
  text.replaceChildren();
  const dot = (kind) => el("span", `dot ${kind ?? ""}`);
  if (model.state !== "ready") {
    text.append(dot("warn"), model.state === "downloading" ? t("받아쓰기 모델 내려받는 중…") : model.state === "loading" ? t("받아쓰기 모델 불러오는 중…") : t("받아쓰기 모델이 필요합니다 · ⚙"));
    return;
  }
  if (processing) return text.append(dot("brand"), processing);
  if (agentBusy) return text.append(dot("brand"), barNote ?? t("작업 중…"));
  if (barNote) return text.append(dot("brand"), barNote);
  // 쉬는 동안 막대에는 회의 앱을 알아챘을 때만 상황을 띄운다 (스피커 경고도 그때만). 장치·경고 전체는 💬 판에서
  if (!context?.app) return text.append(t("녹음하거나, 말로 일을 시키세요"));
  const name = context.app.inMeeting ? t("{app} 회의 중", { app: context.app.name }) : t("{app} 켜짐", { app: context.app.name });
  if (context.output?.speaker) return text.append(dot("warn"), t("{name} · 스피커라 이어폰 권장", { name }));
  text.append(dot("brand"), name);
}

// 💬 실시간 글: 녹음 중이면 받아쓰는 글, 작업이면 대화
// 모델이 준비되지 않았을 때 막대 가운데를 누르면 모델 설정으로
$("barCenter").onclick = () => {
  if (model.state !== "ready" && !recording && !dictating) openSettings("set-models");
};

$("streamToggle").onclick = () => {
  const target = recording ? "recordView" : dictating || agentBusy ? "agentView" : lastActivity === "agent" ? "agentView" : "recordView";
  const open = openView();
  if (open === target || (open && (open === "recordView" || open === "agentView"))) return showView(open === target ? null : target);
  if (target === "agentView") showAgent();
  else showView("recordView");
};
// ☰: 목록이 열려 있으면 닫고, 기록을 보고 있으면 목록으로 돌아가고, 아니면 목록을 연다
$("drawerToggle").onclick = () => {
  const open = openView();
  showView(open === "listView" ? null : "listView");
  // 검색칸에 바로 커서를 두지 않는다 (열자마자 진한 테두리가 생겨 시선을 뺏는다). ⌘F로 검색
};
document.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === "f") {
    e.preventDefault();
    if (openView() !== "listView") showView("listView");
    $("searchInput").focus();
  }
  if (e.key === "Escape" && openView() && !e.target.closest("input, select, textarea")) showView(null);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
    e.preventDefault();
    $("drawerToggle").click();
  }
});

// ───────── 작업: 말로 등록된 도구에 일 시키기 ─────────

const ENGINE_NAMES = { codex: "Codex", claude: "Claude Code", grok: "Grok" };
let agentLoaded = false;
let agentBusy = false;
let agentBubble = null; // 지금 받고 있는 답 말풍선
let agentAnswer = "";
let dictation = null; // 마이크
let dictating = false;

function showAgent() {
  showView("agentView");
  renderAgentTarget();
  if (!agentLoaded) loadAgentHistory();
}

function renderAgentTarget() {
  const folder = settings?.agentFolder ? settings.agentFolder.split("/").filter(Boolean).at(-1) : t("작업 폴더를 고르세요");
  $("agentTarget").textContent = `${ENGINE_NAMES[settings?.agentEngine] ?? "Codex"} · ${folder}`;
}
$("agentTarget").onclick = () => !agentBusy && !dictating && openFolderPicker();

function agentLine(role, text) {
  const log = $("agentLog");
  log.querySelector(".agent-empty")?.remove();
  // 도구가 한 일(명령·파일·승인)은 이어지는 것끼리 "작업 단계 N개" 한 줄로 접어 둔다
  if (role === "activity") {
    let steps = log.lastElementChild?.classList.contains("thinking") ? log.lastElementChild.previousElementSibling : log.lastElementChild;
    if (!steps?.classList.contains("steps")) {
      steps = el("details", "steps");
      steps.append(el("summary"), el("ol"));
      log.querySelector(".thinking") ? log.insertBefore(steps, log.querySelector(".thinking")) : log.append(steps);
    }
    steps.querySelector("ol").append(el("li", null, text));
    steps.querySelector("summary").textContent = t("작업 단계 {n}개", { n: steps.querySelectorAll("li").length });
    log.scrollTop = log.scrollHeight;
    return steps;
  }
  const node = el("div", `msg ${role}`);
  if (role === "assistant" && text) node.replaceChildren(richText(text));
  else node.textContent = text;
  log.append(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

// 답의 마크다운 중 자주 쓰는 것만 그린다: 문단, 목록, 제목, 코드 블록, `코드`, **굵게**.
// 링크는 글자만 남긴다 (앱 창 안에서 다른 페이지로 넘어가지 않도록). HTML은 그리지 않는다.
function richText(text) {
  const frag = document.createDocumentFragment();
  const inline = (parent, line) => {
    for (const part of line.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/)) {
      if (!part) continue;
      if (/^`[^`]+`$/.test(part)) parent.append(el("code", null, part.slice(1, -1)));
      else if (/^\*\*[^*]+\*\*$/.test(part)) parent.append(el("strong", null, part.slice(2, -2)));
      else if (/^\[[^\]]+\]\([^)]+\)$/.test(part)) parent.append(part.slice(1, part.indexOf("]")));
      else parent.append(part);
    }
    return parent;
  };
  const lines = text.replace(/\r/g, "").split("\n");
  let list = null;
  let para = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      const pre = el("pre");
      pre.append(el("code", null, code.join("\n")));
      frag.append(pre);
      list = para = null;
      continue;
    }
    const item = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (item) {
      const tag = item[1] ? "ol" : "ul";
      if (list?.tagName.toLowerCase() !== tag) frag.append((list = el(tag)));
      list.append(inline(el("li"), item[2]));
      para = null;
      continue;
    }
    list = null;
    if (!line.trim()) {
      para = null;
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      frag.append(inline(el("p", "md-heading"), heading[1]));
      para = null;
      continue;
    }
    if (para) para.append(el("br"));
    else frag.append((para = el("p")));
    inline(para, line);
  }
  return frag;
}

// 받는 동안에는 글자 그대로, 다 받으면 마크다운으로 다시 그린다
function finishBubble() {
  if (agentBubble?.dataset.raw) agentBubble.replaceChildren(richText(agentBubble.dataset.raw));
  agentBubble = null;
}

function showThinking(on) {
  $("agentLog").querySelector(".thinking")?.remove();
  if (on) {
    const t = el("div", "thinking");
    t.append(el("span"), el("span"), el("span"));
    $("agentLog").append(t);
    $("agentLog").scrollTop = $("agentLog").scrollHeight;
  }
}

function setAgentBusy(busy) {
  agentBusy = busy;
  $("agentStop").hidden = !busy;
  // 작업 중에도 보낼 수 있다 (Codex는 하던 작업에 더하고, Claude Code는 끝난 뒤 이어서)
  $("agentInput").placeholder = busy ? t("작업 중에 더할 말") : t("입력해서 일 시키기");
  $("agentNew").disabled = busy;
  $("workButton").classList.toggle("busy", busy);
  showThinking(busy && !agentBubble);
  renderBar();
  reportState();
}

async function loadAgentHistory() {
  agentLoaded = true;
  const { history, busy } = await api("/api/agent");
  $("agentLog").replaceChildren();
  const shown = history.filter((h) => h.role !== "approval");
  for (const h of shown) agentLine(h.role, h.text);
  // 앱이 닫히는 등으로 답 없이 끊긴 작업은 그렇다고 알려 준다 (작업 단계만 있고 끝이 비어 보이지 않게)
  if (!busy && ["activity", "user"].includes(shown.at(-1)?.role)) agentLine("system", t("이 작업은 답 없이 끝났습니다 · 다시 말하면 이어서 합니다"));
  if (!history.length) $("agentLog").append(el("p", "agent-empty", t("작업 버튼(⌥V)을 누르고 말로 일을 시켜 보세요.\n예: “오늘 회의록에서 할 일만 정리해서 todo.md로 만들어 줘”")));
  setAgentBusy(busy);
}

// 작업 중에 보내면 서버가 진행 중인 작업에 더하거나(Codex) 끝난 뒤 이어서 보낸다
async function sendAgent(text) {
  text = text.trim();
  if (!text) return;
  try {
    await api("/api/agent/send", { method: "POST", body: JSON.stringify({ text }) });
    $("agentInput").value = "";
  } catch (error) {
    barNote = error.message;
    renderBar();
    if (!$("agentView").hidden) agentLine("error", error.message);
  }
}
$("agentForm").onsubmit = (e) => {
  e.preventDefault();
  sendAgent($("agentInput").value);
};
$("agentStop").onclick = () => api("/api/agent/interrupt", { method: "POST" });
$("agentNew").onclick = async () => {
  try {
    await api("/api/agent/new", { method: "POST" });
    agentLine("system", t("새 대화를 시작했습니다."));
  } catch (error) {
    agentLine("error", error.message);
  }
};

function approvalCard(m) {
  const card = el("div", "approval");
  card.dataset.id = m.id;
  card.append(el("span", "approval-title", t("{kind} — 허용할까요?", { kind: m.kind })), el("code", null, m.detail));
  const actions = el("div", "approval-actions");
  const answer = async (allow) => {
    actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await api(`/api/agent/approval/${m.id}`, { method: "POST", body: JSON.stringify({ allow }) }).catch(() => {});
  };
  const yes = el("button", "primary", t("허용"));
  yes.type = "button";
  yes.onclick = () => answer(true);
  const no = el("button", null, t("거절"));
  no.type = "button";
  no.onclick = () => answer(false);
  actions.append(yes, no);
  card.append(actions);
  return card;
}

const firstSentence = (text) => (text.replace(/\s+/g, " ").trim().match(/^.{1,90}?[.!?。]|^.{1,90}/)?.[0] ?? "").trim();

async function handleAgentMessage(m) {
  if (m.type === "agent-start") {
    lastActivity = "agent";
    agentAnswer = "";
    barNote = t("작업 중 · {text}", { text: m.text });
    if (agentLoaded) agentLine("user", m.text);
    agentBubble = null;
    setAgentBusy(true);
  } else if (m.type === "agent-delta") {
    agentAnswer += m.text;
    barNote = firstSentence(agentAnswer);
    renderBar();
    if (!agentLoaded) return;
    showThinking(false);
    agentBubble ??= agentLine("assistant", "");
    agentBubble.dataset.raw = (agentBubble.dataset.raw ?? "") + m.text;
    agentBubble.textContent = agentBubble.dataset.raw;
    $("agentLog").scrollTop = $("agentLog").scrollHeight;
  } else if (m.type === "agent-activity") {
    if (!agentAnswer) barNote = t("작업 중 · {text}", { text: m.text });
    renderBar();
    if (!agentLoaded) return;
    finishBubble();
    showThinking(false);
    agentLine("activity", m.text);
    if (agentBusy) showThinking(true);
  } else if (m.type === "agent-approval") {
    // 승인은 사람이 답해야 하므로 대화 판을 연다
    if (!agentLoaded) await loadAgentHistory();
    showAgent();
    showThinking(false);
    $("agentLog").append(approvalCard(m));
    $("agentLog").scrollTop = $("agentLog").scrollHeight;
  } else if (m.type === "agent-approval-done") {
    const card = $("agentLog").querySelector(`.approval[data-id="${m.id}"]`);
    card?.classList.add("done");
    card?.querySelector(".approval-title")?.replaceChildren(m.allow ? t("허용함") : t("거절함"));
    card?.querySelector(".approval-actions")?.remove();
  } else if (m.type === "agent-steer" || m.type === "agent-queued") {
    barNote = m.type === "agent-steer" ? t("작업에 더함 · {text}", { text: m.text }) : t("끝나면 이어서 · {text}", { text: m.text });
    renderBar();
    if (agentLoaded) agentLine("user", m.text);
  } else if (m.type === "agent-done") {
    barNote = m.error ? t("작업 실패 · {error}", { error: m.error }) : `${firstSentence(agentAnswer || m.text) || t("끝났습니다")}`;
    if (agentLoaded) {
      showThinking(false);
      if (m.error) agentLine("error", m.error);
    }
    finishBubble();
    setAgentBusy(false);
    setTimeout(() => {
      if (!agentBusy) {
        barNote = null;
        renderBar();
      }
    }, 20000);
  }
}

// 대화 모드: 작업 버튼을 한 번 누르면 마이크가 켜진 채로 계속 듣는다.
// 말이 1.5초 멈추면 그 말을 작업으로 보내고, 답을 소리로 읽은 뒤 "띵"이 나면 다시 말하면 된다. 다시 누르면 끝.
let heardText = null; // 지금 말하는 중인 말 (미리보기)
let listenHint = t("마이크 준비 중…");
// "agent" = 말로 작업(⌥V) | "paste" = 아무 앱에 받아쓰기(⌥D): 끝내면 받아쓴 글을 지금 앞에 있는 앱에 붙여넣는다
let dictationMode = "agent";
async function startDictation(mode = "agent") {
  if (dictating || recording) return;
  if (model.state !== "ready") return;
  if (mode === "agent" && !settings?.agentFolder) return openFolderPicker();
  try {
    dictation = await openMic();
  } catch (error) {
    barNote = t("마이크를 쓸 수 없습니다: {message}", { message: error.message });
    renderBar();
    return;
  }
  dictating = true;
  dictationMode = mode;
  lastActivity = "agent";
  barNote = null;
  heardText = null;
  listenHint = t("마이크 준비 중…");
  agentWave.attach(dictation.analyser);
  $("workButton").classList.add("listening");
  $("workButton").setAttribute("aria-label", t("대화 중 · 누르면 끝"));
  ws.send(JSON.stringify({ type: "dictate-start", mode }));
  renderBar();
  reportState();
}

// cancel: 하던 말은 버린다 (녹음 시작 등). ended: 서버가 이미 끝냈다
function stopDictation({ cancel = false, ended = false } = {}) {
  if (!dictating) return;
  if (!ended) ws.send(JSON.stringify({ type: cancel ? "dictate-cancel" : "dictate-stop" }));
  closeMic(dictation);
  dictation = null;
  dictating = false;
  heardText = null;
  agentWave.detach();
  $("workButton").classList.remove("listening");
  $("workButton").setAttribute("aria-label", t("말로 작업 시키기"));
  $("barText").classList.remove("heard");
  renderBar();
  reportState();
}

// 작업 버튼: 먼저 작업 폴더를 고르고, 고르면 바로 듣기 시작. 듣는 중이면 끝, 폴더 목록이 열려 있으면 닫기
$("workButton").onclick = () => {
  if (dictating) return stopDictation();
  if (recording) return;
  if (!$("folderView").hidden) return showView(null);
  openFolderPicker();
};

// ───────── 작업 폴더 고르기 ─────────
// 폴더 목록은 사용자가 × 로 뺄 때까지 남는다. 고른 폴더가 맨 위로 올라가 다음에 Enter·⌥V로 바로 쓸 수 있다
let folderItems = [];
async function openFolderPicker() {
  showView("folderView");
  renderFolderEngine();
  $("folderPathForm").hidden = true;
  await renderFolders(await api("/api/agent/folders"));
}

// 폴더와 함께 일할 도구도 여기서 고른다 (설정의 "작업 도구"와 같은 값). 이 맥에 설치·로그인된 것만 고를 수 있다.
// 회사마다 그 회사의 공식 작업 도구(CLI)가 일한다
const ENGINE_LABELS = { codex: "Codex · OpenAI", claude: "Claude Code · Anthropic", grok: "Grok Build · xAI" };
let engineStatus = null;
async function renderFolderEngine() {
  const select = $("folderEngine");
  const draw = () => {
    select.replaceChildren(
      ...Object.entries(ENGINE_LABELS).map(([id, label]) => {
        const ready = engineStatus?.[id] ?? true;
        const option = new Option(ready ? label : t("{label} (로그인 필요)", { label }), id);
        option.disabled = !ready && id !== settings?.agentEngine;
        return option;
      }),
    );
    select.value = settings?.agentEngine ?? "codex";
    select.disabled = agentBusy;
  };
  draw();
  if (!engineStatus) {
    const { engines } = await api("/api/agent/engines").catch(() => ({ engines: [] }));
    engineStatus = Object.fromEntries(engines.map((e) => [e.id, e.ready]));
    draw();
  }
}
$("folderEngine").onchange = async () => {
  const engine = $("folderEngine").value;
  ({ settings } = await api("/api/settings", { method: "POST", body: JSON.stringify({ agentEngine: engine }) }));
  const radio = form.querySelector(`input[name="agentEngine"][value="${engine}"]`);
  if (radio) radio.checked = true;
  renderAgentTarget();
};

function ago(at) {
  if (!at) return t("아직 대화 없음");
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return t("방금");
  if (minutes < 60) return t("{n}분 전", { n: minutes });
  if (minutes < 60 * 24) return t("{n}시간 전", { n: Math.round(minutes / 60) });
  return t("{n}일 전", { n: Math.round(minutes / 60 / 24) });
}

function renderFolders({ folders, current, home }) {
  folderItems = folders;
  queueMicrotask(refitPanel);
  const list = $("folderList");
  if (!folders.length) {
    list.replaceChildren(el("p", "empty-list", t("아직 작업 폴더가 없습니다.\n아래 “+ 폴더 추가”로 일할 폴더를 고르세요. 한 번 넣으면 목록에 남습니다.")));
    list.firstChild.style.whiteSpace = "pre-line";
    return;
  }
  list.replaceChildren(
    ...folders.map((f, i) => {
      const row = el("div", `folder-row${f.path === current ? " current" : ""}${f.exists ? "" : " missing"}`);
      const pick = el("button", "pick-folder");
      pick.type = "button";
      pick.disabled = !f.exists;
      const text = el("span", "folder-text");
      const where = home && f.path.startsWith(home) ? `~${f.path.slice(home.length)}` : f.path;
      text.append(el("span", "item-title", f.name), el("span", "item-meta", f.exists ? `${where} · ${ago(f.lastAt)}` : `${where} · ${t("폴더를 찾을 수 없음")}`));
      pick.append(el("span", "folder-key", i < 9 ? String(i + 1) : ""), text);
      pick.onclick = () => chooseFolder(f.path);
      const remove = el("button", "remove-folder");
      const x = sfSymbols["xmark.circle.fill@14"];
      remove.append(x ? sfIcon(x) : "ⓧ");
      remove.type = "button";
      remove.title = t("목록에서 빼기 (폴더와 파일은 그대로)");
      remove.setAttribute("aria-label", t("{name} 목록에서 빼기", { name: f.name }));
      remove.onclick = async () => renderFolders(await api("/api/agent/folders", { method: "POST", body: JSON.stringify({ remove: f.path }) }));
      row.append(pick, remove);
      return row;
    }),
  );
}

// 폴더를 고르면 그 폴더의 대화를 열고 바로 듣기 시작한다
async function chooseFolder(path, { add = false } = {}) {
  try {
    const result = await api("/api/agent/folders", { method: "POST", body: JSON.stringify(add ? { add: path } : { select: path }) });
    settings = { ...settings, agentFolder: result.current };
  } catch (error) {
    barNote = error.message;
    renderBar();
    return;
  }
  agentLoaded = false;
  showAgent();
  startDictation();
}

$("folderAdd").onclick = () => {
  if (isMacApp) return window.webkit.messageHandlers.pickFolder.postMessage("agentFolderAdd");
  $("folderPathForm").hidden = false;
  $("folderPathInput").focus();
};
$("folderPathForm").onsubmit = (e) => {
  e.preventDefault();
  const path = $("folderPathInput").value.trim();
  if (path) chooseFolder(path, { add: true });
};
$("folderListButton").onclick = openFolderPicker;

document.addEventListener("keydown", (e) => {
  if ($("folderView").hidden || e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const index = e.key === "Enter" ? 0 : /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
  const folder = folderItems[index];
  if (!folder?.exists) return;
  e.preventDefault();
  chooseFolder(folder.path);
});

function handleDictation(m) {
  if (m.type === "dictate-ready") {
    // 처음 마이크가 켜졌을 때, 그리고 답을 다 읽은 뒤: 이제 말할 차례
    listenHint =
      dictationMode === "paste"
        ? t("말하세요 · {key}를 다시 누르면 붙여넣기", { key: hotkeyLabel(settings?.dictationHotkey) || t("단축키") })
        : t("말하세요 · 작업 버튼을 다시 누르면 끝");
    if (!agentBusy) barNote = null;
  }
  if (m.type === "dictate-partial") heardText = m.text || null;
  if (m.type === "dictation") {
    heardText = null;
    if (m.mode === "paste") pasteText(m.text);
    else sendAgent(m.text);
  }
  if (m.type === "dictate-end") {
    stopDictation({ ended: true });
    if (m.reason) barNote = m.reason;
  }
  renderBar();
}

// 맥 앱 단축키(⌥V)·메뉴: 막대에서 바로 듣기
function agentTalk() {
  if (recording) return;
  dictating ? stopDictation() : startDictation("agent");
}

// 맥 앱 단축키(⌥D): 누르면 듣기, 다시 누르면 받아써서 지금 앱에 붙여넣기
function dictateToggle() {
  if (recording) return;
  if (dictating) return stopDictation(); // 말로 작업 중이었어도 끝낸다 (두 번 눌러 받아쓰기를 다시 시작)
  startDictation("paste");
}

// 붙여넣기는 운영체제마다 다르다: 이 함수 하나만 플랫폼별로 바뀐다.
// 맥 앱: 네이티브(VoinApp.swift)가 클립보드에 넣고 ⌘V를 보낸 뒤 원래 클립보드를 되돌린다.
// 다른 플랫폼(앞으로 Windows 등)은 같은 { type: "paste", text } 메시지를 받아 처리하면 된다.
// 네이티브가 없으면(브라우저) 클립보드에 복사만 한다.
function pasteText(text) {
  if (!text) return;
  if (isMacApp) return tellNative({ type: "paste", text });
  navigator.clipboard?.writeText(text).then(
    () => showPasteResult(true, t("클립보드에 복사했습니다")),
    () => showPasteResult(false, t("클립보드에 복사하지 못했습니다")),
  );
}
// 네이티브가 붙여넣기 결과를 알려 준다 (손쉬운 사용 권한이 없으면 클립보드에만 넣고 안내)
function showPasteResult(ok, message) {
  barNote = ok ? (message || t("붙여넣었습니다")) : message;
  renderBar();
  setTimeout(() => {
    if (barNote === message || barNote === t("붙여넣었습니다")) {
      barNote = null;
      renderBar();
    }
  }, ok ? 3000 : 10000);
}
window.pasteResult = showPasteResult;

// ───────── 시작 ─────────

const emptyState = document.querySelector("#transcript .empty-state").cloneNode(true);
function newMeeting() {
  if (recording) return;
  if ($("recordView").hidden || !$("transcript").querySelector(".empty-state")) {
    $("transcript").replaceChildren(emptyState.cloneNode(true));
    $("title").value = "";
    renderShortcutHint();
  }
  showView("recordView");
  $("title").focus();
}

// 빈 화면 안내: 맥 앱이면 어디서든 쓰는 단축키를 알려 준다
function renderShortcutHint() {
  const hint = $("shortcutHint");
  if (!hint) return;
  $("toggle").title = `${t("녹음")}${isMacApp && settings?.hotkey ? ` (${hotkeyLabel(settings.hotkey)})` : ""}`;
  $("workButton").title = `${t("말로 작업")}${isMacApp && settings?.agentHotkey ? ` (${hotkeyLabel(settings.agentHotkey)})` : ""}`;
  hint.hidden = false;
  if (!hint.hidden) {
    hint.replaceChildren(t("녹음 파일을 창에 끌어다 놓으면 받아씁니다"));
  }
  if ($("systemHint")) $("systemHint").hidden = !$("includeSystem").checked;
}

$("toggle").onclick = () => (recording ? stopRecording() : startRecording());
$("newMeeting").onclick = newMeeting;
$("importButton").onclick = () => $("importInput").click();
$("importInput").onchange = () => {
  const file = $("importInput").files[0];
  $("importInput").value = "";
  if (file) importFile(file);
};
// ⚙: 설정이 열려 있으면 닫고(막대로 줄이고), 아니면 연다
$("settingsButton").onclick = () => (openView() === "settingsView" ? showView(null) : openSettings());
$("openFolder").onclick = () => api("/api/open-folder", { method: "POST" }).catch((e) => setJobStatus(e.message));
$("jobStatus").onclick = () => setJobStatus(null);
$("includeSystem").onchange = () => {
  if ($("systemHint")) $("systemHint").hidden = !$("includeSystem").checked;
  renderContextRow();
  renderBar();
};
window.addEventListener("beforeunload", (event) => {
  if (recording) event.preventDefault();
});

// 맥 앱 메뉴(⌘N, ⌘O, ⌘,)에서 부른다
// 단축키·메뉴 막대에서 녹음 시작/중지: 다른 화면을 보고 있었으면 녹음 화면으로 돌아간다
function toggleRecording() {
  if (recording) return stopRecording();
  if ($("toggle").disabled) return;
  if (dictating) stopDictation({ cancel: true });
  startRecording();
}

window.app = {
  newMeeting,
  openSettings,
  toggleRecording,
  agentTalk,
  dictateToggle,
  modelAction,
  importFile: () => !recording && $("importInput").click(),
  openFolder: () => api("/api/open-folder", { method: "POST" }),
};

({ settings } = await api("/api/settings"));
$("includeSystem").checked = settings.includeSystemDefault;
$("includeSystem").onchange();
renderShortcutHint();
tellNative({ type: "hotkey", hotkey: settings.hotkey });
tellNative({ type: "hotkey2", hotkey: settings.agentHotkey });
tellNative({ type: "hotkey3", hotkey: settings.dictationHotkey });
tellNative({ type: "menuBarIcon", visible: settings.menuBarIcon });
const remembered = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
showView(null);
refreshContext();
setInterval(() => !recording && !dictating && refreshContext(), 6000);
connect();
loadMeetingList();
refreshMicList();
