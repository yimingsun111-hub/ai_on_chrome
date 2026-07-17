import { PRESETS, loadConfig } from "./lib/providers.js";
import { runTask } from "./lib/agent.js";
import { loadTheme, applyTheme } from "./lib/theme.js";
import { mountFloatingPanel } from "./lib/page.js";
import { LANGUAGES, loadLang, saveLang, setCurrent, detectDefault, t } from "./lib/i18n.js";

const logEl = document.getElementById("log");
const inputEl = document.getElementById("input");
const runBtn = document.getElementById("run");
const stopBtn = document.getElementById("stop");
const activeModelEl = document.getElementById("active-model");

let stopped = false;
let running = false;
let runController = null;
const conversation = []; // 跨轮对话上下文：{role:'user'|'assistant', content}

// ── 聊天记录持久化（会话级：浏览器关闭即清空）──────────────
// 侧边栏和浮窗是两个独立页面实例，记录存到 storage.session 里两边共享、切换不丢。
const HISTORY_KEY = "chatHistory";
let transcript = []; // 所有显示过的消息：{role, text}

function renderMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function addMessage(role, text) {
  renderMessage(role, text);
  transcript.push({ role, text });
  chrome.storage.session.set({ [HISTORY_KEY]: transcript }).catch(() => {});
}

async function restoreHistory() {
  try {
    const d = await chrome.storage.session.get(HISTORY_KEY);
    transcript = d[HISTORY_KEY] || [];
    for (const m of transcript) {
      renderMessage(m.role, m.text);
      // 只有用户指令和 AI 回复进入模型上下文
      if (m.role === "user") conversation.push({ role: "user", content: m.text });
      else if (m.role === "assistant") conversation.push({ role: "assistant", content: m.text });
    }
  } catch (_) {}
}

// ── 多语言 ──────────────────────────
// 把当前语言文案写进界面（静态部分）
function applyI18n() {
  const primaryKey = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? "Cmd" : "Ctrl";
  inputEl.placeholder = t("inputPlaceholder");
  document.getElementById("hint").textContent = t("runHint").replace("Cmd", primaryKey);
  document.getElementById("float").title = t("tFloat");
  document.getElementById("newchat").title = t("tNewchat");
  document.getElementById("settings").title = t("tSettings");
  document.getElementById("attach").title = t("tAttach");
  runBtn.title = t("tRun").replace("Cmd", primaryKey);
  stopBtn.title = t("tStop");
  logEl.dataset.l1 = t("emptyTitle");
  logEl.dataset.l2 = t("emptyEx1");
  logEl.dataset.l3 = t("emptyEx2");
}

// 首次启动：让用户选语言（各语言用母语显示，无需翻译标题）
function showLangPicker() {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.id = "langpick";
    const box = document.createElement("div");
    box.className = "lp-box";
    const title = document.createElement("div");
    title.className = "lp-title";
    title.textContent = "选择语言 · Choose language";
    box.appendChild(title);
    for (const l of LANGUAGES) {
      const btn = document.createElement("button");
      btn.textContent = l.name;
      btn.addEventListener("click", async () => {
        await saveLang(l.id);
        setCurrent(l.id);
        applyI18n();
        ov.remove();
        resolve();
      });
      box.appendChild(btn);
    }
    ov.appendChild(box);
    document.body.appendChild(ov);
  });
}

async function initLang() {
  const saved = await loadLang();
  if (saved) {
    setCurrent(saved);
    applyI18n();
  } else {
    setCurrent(detectDefault());
    applyI18n();
    await showLangPicker();
  }
}

// 顶栏显示当前使用的模型 / 是否已配置
async function refreshActiveModel() {
  const cfg = await loadConfig();
  if (cfg.apiKey) {
    const preset = PRESETS.find((p) => p.id === cfg.providerId);
    const providerName = preset ? t(preset.labelKey) : (cfg.name || "Custom");
    activeModelEl.textContent = `${providerName} · ${cfg.model}`;
    activeModelEl.style.color = "";
  } else {
    activeModelEl.textContent = t("notConfigured");
    activeModelEl.style.color = "var(--danger)";
  }
}

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("newchat").addEventListener("click", () => {
  conversation.length = 0;
  transcript = [];
  logEl.innerHTML = "";
  chrome.storage.session.remove(HISTORY_KEY).catch(() => {});
});

// 浮窗模式：把本面板作为悬浮窗挂到当前网页上
document.getElementById("float").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || /^(chrome|edge|about|chrome-extension|devtools|view-source|file):/i.test(tab.url || "")) {
    addMessage("error", t("floatInternalPage"));
    return;
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: mountFloatingPanel,
      args: [chrome.runtime.getURL("panel.html?float=1")]
    });
    if (res?.result?.ok) {
      // 侧边栏无法用 window.close() 关闭，让后台 disable/enable 一下来收起它
      chrome.runtime.sendMessage({ type: "closeSidePanel" }).catch(() => {});
    } else {
      addMessage("error", t("floatFailed", res?.result?.error || "unknown"));
    }
  } catch (e) {
    addMessage("error", t("floatError", e.message));
  }
});

// 浮窗里运行时：隐藏"以浮窗打开"按钮（已经是浮窗了）
if (new URLSearchParams(location.search).get("float") === "1") {
  document.getElementById("float").style.display = "none";
}

// 主题
async function refreshTheme() {
  applyTheme(document, await loadTheme());
}
refreshTheme();

// 配置/主题/语言变化时（在设置页保存后）实时刷新——只关心 local 区，避免每条聊天记录写入都触发
chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== "local") return;
  const lang = await loadLang();
  if (lang) { setCurrent(lang); applyI18n(); }
  refreshActiveModel();
  refreshTheme();
});

function setRunning(on) {
  running = on;
  document.body.classList.toggle("running", on);
  runBtn.disabled = on;
}

// ── 附件（图片/文本文件，随任务发给模型）──────────────
const attachmentsEl = document.getElementById("attachments");
const fileInputEl = document.getElementById("file-input");
const MAX_IMAGES = 3;
const MAX_TEXT_CHARS = 50000;
const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|xml|ya?ml|log|tsv)$/i;

let attachments = []; // {kind:'image', dataUrl, name} | {kind:'text', text, name}

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  attachments.forEach((att, i) => {
    const card = document.createElement("div");
    card.className = "att-card";
    if (att.kind === "image") {
      const img = document.createElement("img");
      img.src = att.dataUrl;
      card.appendChild(img);
    } else {
      const icon = document.createElement("div");
      icon.className = "att-file-icon";
      icon.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
      card.appendChild(icon);
    }
    const name = document.createElement("span");
    name.className = "att-name";
    name.textContent = att.name;
    name.title = att.name;
    card.appendChild(name);

    const rm = document.createElement("button");
    rm.className = "att-remove";
    rm.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    rm.addEventListener("click", () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    card.appendChild(rm);
    attachmentsEl.appendChild(card);
  });
}

// 大图缩到最长边 1600px 再发，省 token 和带宽
function downscaleImage(dataUrl, maxDim = 1600) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale >= 1) return resolve(dataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // 透明 PNG 转 JPEG 时垫白底
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (file.type.startsWith("image/")) {
      if (attachments.filter((a) => a.kind === "image").length >= MAX_IMAGES) {
        addMessage("system", t("attachTooMany"));
        continue;
      }
      const raw = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      const dataUrl = await downscaleImage(raw);
      attachments.push({ kind: "image", dataUrl, name: file.name || "image" });
    } else if (file.type.startsWith("text/") || TEXT_EXT.test(file.name || "")) {
      const text = await file.text();
      attachments.push({ kind: "text", text: text.slice(0, MAX_TEXT_CHARS), name: file.name || "file.txt" });
    } else {
      addMessage("system", t("attachUnsupported", file.name || file.type || "?"));
    }
  }
  renderAttachments();
}

document.getElementById("attach").addEventListener("click", () => fileInputEl.click());
fileInputEl.addEventListener("change", async () => {
  await addFiles([...fileInputEl.files]);
  fileInputEl.value = ""; // 允许重复选同一个文件
});

// 粘贴图片
inputEl.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// 拖拽文件到面板
const composerEl = document.getElementById("composer");
document.body.addEventListener("dragover", (e) => {
  e.preventDefault();
  composerEl.classList.add("dragover");
});
document.body.addEventListener("dragleave", () => composerEl.classList.remove("dragover"));
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  composerEl.classList.remove("dragover");
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
});

async function run() {
  const task = inputEl.value.trim();
  if (!task || running) return;

  const taskAttachments = attachments;
  attachments = [];
  renderAttachments();

  // 用户气泡里带上附件名，跨轮上下文也只记文字（附件本体不进历史，保持轻量）
  const names = taskAttachments.map((a) => a.name).join(", ");
  const shownTask = names ? `${task}\n${t("attachLine", names)}` : task;
  addMessage("user", shownTask);
  inputEl.value = "";

  stopped = false;
  runController = new AbortController();
  setRunning(true);

  try {
    const answer = await runTask(task, addMessage, () => stopped, conversation, taskAttachments, runController.signal);
    conversation.push({ role: "user", content: shownTask });
    if (answer) conversation.push({ role: "assistant", content: answer });
  } catch (e) {
    addMessage("error", t("errPrefix", e.message));
  } finally {
    runController = null;
    setRunning(false);
  }
}

runBtn.addEventListener("click", run);
stopBtn.addEventListener("click", () => {
  stopped = true;
  runController?.abort();
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
});

// 启动：先定语言（首次会弹选择），再恢复记录和顶栏
(async () => {
  await initLang();
  await restoreHistory();
  await refreshActiveModel();
})();
