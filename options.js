import { PRESETS, loadConfig, saveConfig, testConnection } from "./lib/providers.js";
import { DEFAULT_THEME, loadTheme, saveTheme, applyTheme } from "./lib/theme.js";
import { LANGUAGES, loadLang, saveLang, setCurrent, detectDefault, t } from "./lib/i18n.js";
import { DEFAULT_ACTION_PERMISSIONS, loadActionPermissions, saveActionPermissions } from "./lib/permissions.js";

const $ = (id) => document.getElementById(id);

// ── 多语言 ──
// 页面上所有带 data-i18n 的元素按当前语言重渲染
function translatePage() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const p of PRESETS) {
    const option = document.querySelector(`#provider option[value="${p.id}"]`);
    if (option) option.textContent = t(p.labelKey);
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
const THEME_COLOR_KEYS = ["bg", "surface", "text", "border", "accent", "glow"];

async function initTheme() {
  const theme = await loadTheme();
  for (const k of THEME_COLOR_KEYS) $("th-" + k).value = theme[k];
  $("th-liquidGlass").checked = !!theme.liquidGlass;
  applyTheme(document, theme);
}

async function onThemeChange() {
  const theme = { liquidGlass: $("th-liquidGlass").checked };
  for (const k of THEME_COLOR_KEYS) theme[k] = $("th-" + k).value;
  await saveTheme(theme); // 即时保存；panel 监听 storage 变化会同步生效
  applyTheme(document, theme);
}

for (const k of THEME_COLOR_KEYS) $("th-" + k).addEventListener("input", onThemeChange);
$("th-liquidGlass").addEventListener("change", onThemeChange);

$("resetTheme").addEventListener("click", async () => {
  await saveTheme({ ...DEFAULT_THEME });
  await initTheme();
});

initTheme();

// ── 全局动作权限（所有网站共用一份） ──
const PERMISSION_KEYS = Object.keys(DEFAULT_ACTION_PERMISSIONS);

async function initPermissions() {
  const permissions = await loadActionPermissions();
  for (const key of PERMISSION_KEYS) $("perm-" + key).checked = permissions[key] !== false;
}

async function onPermissionChange() {
  const permissions = {};
  for (const key of PERMISSION_KEYS) permissions[key] = $("perm-" + key).checked;
  await saveActionPermissions(permissions);
}

for (const key of PERMISSION_KEYS) $("perm-" + key).addEventListener("change", onPermissionChange);
initPermissions();

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

function displayConfig(cfg) {
  providerSel.value = cfg.providerId || "deepseek";
  apiKeyEl.value = cfg.apiKey || "";
  baseURLEl.value = cfg.baseURL || "";
  modelEl.value = cfg.model || "";
  $("vision").checked = !!cfg.vision;
  $("useDebugger").checked = !!cfg.useDebugger;
}

// 初始化下拉框
for (const p of PRESETS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = t(p.labelKey);
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
    const saved = await saveConfig(currentConfig());
    displayConfig(saved);
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
    const saved = await saveConfig(cfg);
    displayConfig(saved);
    showStatus(t("stTestOk", reply), "ok");
  } catch (e) {
    showStatus(t("stTestFail", e.message), "err");
  }
});

// 载入已保存的配置
(async () => {
  const cfg = await loadConfig();
  displayConfig(cfg);
})();
