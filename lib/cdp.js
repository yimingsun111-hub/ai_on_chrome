// 通过 chrome.debugger (Chrome DevTools Protocol) 发送"受信任"的真实鼠标/键盘事件。
// 合成 DOM 事件(el.click / dispatchEvent)对 canvas 应用(Google Docs/Figma)无效，必须用这个。

const attached = new Set();

// 关键：debugger 可能被 Chrome 或用户中途断开（导航、点了"取消"提示条等）。
// 监听 onDetach 把内部状态同步掉，避免"以为还连着"却发命令报错。
if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) attached.delete(source.tabId);
  });
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  await send(tabId, "Input.enable", {}).catch(() => {});
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

export async function detachAll() {
  for (const id of [...attached]) await detach(id);
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

async function send(tabId, method, params, _retried) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params || {});
  } catch (e) {
    // 若中途掉线，自动重连一次再重试，让单个动作能自愈
    if (!_retried && /not attached/i.test(e.message || "")) {
      attached.delete(tabId);
      await attach(tabId);
      return send(tabId, method, params, true);
    }
    throw e;
  }
}

// 修饰键位掩码：Alt=1, Ctrl=2, Meta(Cmd)=4, Shift=8
export function modMask({ ctrl, shift, alt, meta } = {}) {
  return (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
}

// 在 (x, y)(CSS 像素、相对视口)真实点击。modifiers 可带 Shift(=8) 做选区。
// clicks: 1=单击, 2=双击(canvas 编辑器里选中整个词), 3=三击(选中整段)
export async function clickAt(tabId, x, y, modifiers = 0, clicks = 1) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers });
  for (let i = 1; i <= clicks; i++) {
    const base = { x, y, button: "left", buttons: 1, clickCount: i, modifiers };
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }
}

// 用 CDP 截图：可截"后台标签页"（无需该标签页可见/聚焦），配合绑定标签页实现后台操作
export async function captureScreenshot(tabId) {
  const res = await send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 60 });
  return "data:image/jpeg;base64," + res.data;
}

// 真实输入一段文字（对 canvas 编辑器也有效）
export async function insertText(tabId, text) {
  await send(tabId, "Input.insertText", { text });
}

const KEYCODES = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32
};

// 按下一个键，可带修饰键(用于快捷键，如 meta+a 全选)
export async function pressKey(tabId, key, modifiers = 0) {
  const code = KEYCODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const params = {
    modifiers,
    key,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code
  };
  await send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

// 滚轮滚动(在视口中心)，canvas 应用也能滚
export async function wheel(tabId, direction, viewport) {
  const x = Math.round((viewport?.width || 800) / 2);
  const y = Math.round((viewport?.height || 600) / 2);
  const deltaY = direction === "up" ? -400 : 400;
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}
