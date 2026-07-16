import { PRESETS, loadConfig, saveConfig, testConnection } from "./lib/providers.js";
import { DEFAULT_THEME, loadTheme, saveTheme, applyTheme } from "./lib/theme.js";
import { LANGUAGES, loadLang, saveLang, setCurrent, detectDefault, t } from "./lib/i18n.js";

const $ = (id) => document.getElementById(id);

// ── 多语言 ──
// 页面上所有带 data-i18n 的元素按当前语言重渲染
function translatePage() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  document.title = t("optTitle") + " · Natural Language Browser Agent";
}

async function initLang() {
  const sel = $("uiLang");
  for (const l of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    sel.appendChild(opt);
  }
  const saved = await loadLang();
  const lang = saved || detectDefault();
  sel.value = lang;
  setCurrent(lang);
  translatePage();
  sel.addEventListener("change", async () => {
    await saveLang(sel.value); // panel 监听 storage 变化会同步切换
    setCurrent(sel.value);
    translatePage();
  });
}
initLang();

// ── Tab 切换 ──
for (const tabBtn of document.querySelectorAll(".tab")) {
  tabBtn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tabBtn));
    document.querySelectorAll(".tabpane").forEach((p) => (p.hidden = p.id !== "tab-" + tabBtn.dataset.tab));
  });
}

// ── 主题 ──
const THEME_KEYS = ["bg", "surface", "text", "border", "accent", "glow"];

async function initTheme() {
  const theme = await loadTheme();
  for (const k of THEME_KEYS) $("th-" + k).value = theme[k];
  applyTheme(document, theme);
}

async function onThemeChange() {
  const theme = {};
  for (const k of THEME_KEYS) theme[k] = $("th-" + k).value;
  await saveTheme(theme); // 即时保存；panel 监听 storage 变化会同步生效
  applyTheme(document, theme);
}

for (const k of THEME_KEYS) $("th-" + k).addEventListener("input", onThemeChange);

$("resetTheme").addEventListener("click", async () => {
  await saveTheme({ ...DEFAULT_THEME });
  await initTheme();
});

initTheme();
const providerSel = $("provider");
const apiKeyEl = $("apiKey");
const baseURLEl = $("baseURL");
const modelEl = $("model");
const statusEl = $("status");

function showStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function currentConfig() {
  const p = PRESETS.find((x) => x.id === providerSel.value) || PRESETS[0];
  return {
    providerId: p.id,
    name: p.name,
    apiKey: apiKeyEl.value.trim(),
    baseURL: baseURLEl.value.trim(),
    model: modelEl.value.trim(),
    vision: $("vision").checked,
    useDebugger: $("useDebugger").checked
  };
}

// 初始化下拉框
for (const p of PRESETS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.name;
  providerSel.appendChild(opt);
}

// 切换服务商时，自动填入该模板的地址和默认模型（不覆盖已填的 Key）
providerSel.addEventListener("change", () => {
  const p = PRESETS.find((x) => x.id === providerSel.value);
  baseURLEl.value = p.baseURL;
  modelEl.value = p.model;
  // 选到带视觉的模型就自动勾上"启用视觉"
  $("vision").checked = !!p.vision;
});

$("save").addEventListener("click", async () => {
  try {
    await saveConfig(currentConfig());
    showStatus(t("stSaved"), "ok");
  } catch (e) {
    showStatus(t("stSaveFail", e.message), "err");
  }
});

$("test").addEventListener("click", async () => {
  const cfg = currentConfig();
  showStatus(t("stTesting"), "info");
  try {
    const reply = await testConnection(cfg);
    // 测试通过就顺手保存，省得用户忘记保存
    await saveConfig(cfg);
    showStatus(t("stTestOk", reply), "ok");
  } catch (e) {
    showStatus(t("stTestFail", e.message), "err");
  }
});

// 载入已保存的配置
(async () => {
  const cfg = await loadConfig();
  providerSel.value = cfg.providerId || "deepseek";
  apiKeyEl.value = cfg.apiKey || "";
  baseURLEl.value = cfg.baseURL || "";
  modelEl.value = cfg.model || "";
  $("vision").checked = !!cfg.vision;
  $("useDebugger").checked = !!cfg.useDebugger;
})();
