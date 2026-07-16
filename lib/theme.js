// 主题配置：统一管理界面颜色（侧边栏/浮窗/设置页共用）和页面光效颜色
export const DEFAULT_THEME = {
  bg: "#fafafa",      // 页面背景
  surface: "#ffffff", // 卡片/输入区表面
  text: "#1f1f1f",    // 文字
  border: "#e8e8e8",  // 边框
  accent: "#2563eb",  // 强调色（按钮/用户气泡）
  glow: "#4285f4"     // 运行时页面四周光效颜色
};

const KEY = "themeConfig";

export async function loadTheme() {
  const d = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_THEME, ...(d[KEY] || {}) };
}

export async function saveTheme(theme) {
  await chrome.storage.local.set({ [KEY]: theme });
}

// 把主题写入某个文档的 CSS 变量（panel 和 options 都用这一套变量名）
export function applyTheme(doc, theme) {
  const map = { bg: "--bg", surface: "--surface", text: "--text", border: "--border", accent: "--accent" };
  for (const [k, v] of Object.entries(map)) {
    doc.documentElement.style.setProperty(v, theme[k]);
  }
}

// #rrggbb → rgba(r,g,b,a)，光效需要带透明度
export function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return `rgba(66,133,244,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
