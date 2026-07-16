import { loadConfig } from "./lib/providers.js";
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
  inputEl.placeholder = t("inputPlaceholder");
  document.getElementById("hint").textContent = t("runHint");
  document.getElementById("float").title = t("tFloat");
  document.getElementById("newchat").title = t("tNewchat");
  document.getElementById("settings").title = t("tSettings");
  runBtn.title = t("tRun");
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
    activeModelEl.textContent = `${cfg.name} · ${cfg.model}`;
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

async function run() {
  const task = inputEl.value.trim();
  if (!task || running) return;
  addMessage("user", task);
  inputEl.value = "";

  stopped = false;
  setRunning(true);

  try {
    const answer = await runTask(task, addMessage, () => stopped, conversation);
    // 存入上下文，让后续"这个/继续"等追问能接上（只存文字，保持轻量）
    conversation.push({ role: "user", content: task });
    if (answer) conversation.push({ role: "assistant", content: answer });
  } catch (e) {
    addMessage("error", t("errPrefix", e.message));
  } finally {
    setRunning(false);
  }
}

runBtn.addEventListener("click", run);
stopBtn.addEventListener("click", () => { stopped = true; });
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
});

// 启动：先定语言（首次会弹选择），再恢复记录和顶栏
(async () => {
  await initLang();
  await restoreHistory();
  await refreshActiveModel();
})();
