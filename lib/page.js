// 这些函数会被注入到目标网页里执行（通过 chrome.scripting.executeScript）。
// 注意：注入函数必须"自包含"，不能引用外部变量。

// 扫描页面，给可交互元素编号，返回一份精简的页面快照
export function buildSnapshot() {
  const MAX_ELEMENTS = 80;
  const selectors = [
    "a[href]", "button", "input", "textarea", "select",
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
    '[role="menuitem"]', '[role="option"]', "[onclick]",
    '[contenteditable="true"]', "summary", "label"
  ].join(",");

  // 清除上一轮的编号
  document.querySelectorAll("[data-ai-agent-id]").forEach((e) => e.removeAttribute("data-ai-agent-id"));

  const elements = [];
  let id = 0;
  for (const el of document.querySelectorAll(selectors)) {
    if (id >= MAX_ELEMENTS) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    // 只保留大致在视口范围内的元素
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;

    el.setAttribute("data-ai-agent-id", String(id));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || "";
    const label = (
      el.innerText || el.value || el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") || el.getAttribute("title") || ""
    ).trim().replace(/\s+/g, " ").slice(0, 120);
    elements.push({
      id, tag, type, label,
      cx: Math.round(rect.left + rect.width / 2),
      cy: Math.round(rect.top + rect.height / 2)
    });
    id++;
  }

  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 3000),
    elements,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    canScrollDown: window.scrollY + window.innerHeight < document.body.scrollHeight - 10,
    canScrollUp: window.scrollY > 10
  };
}

// 在页面上画出编号标记（set-of-marks），让视觉模型能把截图里的位置和编号对应上
export function drawOverlay() {
  document.getElementById("__ai_overlay__")?.remove(); // 内联清除（注入函数不能引用其他函数）
  const layer = document.createElement("div");
  layer.id = "__ai_overlay__";
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  for (const el of document.querySelectorAll("[data-ai-agent-id]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const id = el.getAttribute("data-ai-agent-id");
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #ff2d95;box-sizing:border-box;`;
    const tag = document.createElement("div");
    tag.textContent = id;
    tag.style.cssText = `position:absolute;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 14)}px;background:#ff2d95;color:#fff;font:bold 11px monospace;padding:0 3px;border-radius:3px;line-height:14px;`;
    layer.appendChild(box);
    layer.appendChild(tag);
  }
  document.documentElement.appendChild(layer);
}

export function clearOverlay() {
  document.getElementById("__ai_overlay__")?.remove();
}

// 合成事件的按键（无 debugger 时的降级方案，尽力而为）
export function performKey(action) {
  try {
    const el = document.activeElement || document.body;
    for (const t of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(t, { key: action.key, bubbles: true }));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 在页面上执行一个动作（click / type / scroll）
export function performAction(action) {
  const find = (i) => document.querySelector(`[data-ai-agent-id="${i}"]`);
  try {
    if (action.type === "click") {
      const el = find(action.index);
      if (!el) return { ok: false, error: "找不到该编号的元素" };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.click();
      return { ok: true };
    }
    if (action.type === "type") {
      const el = find(action.index);
      if (!el) return { ok: false, error: "找不到该编号的元素" };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = action.text;
      } else {
        el.value = action.text;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (action.enter) {
        for (const t of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
        if (el.form && el.form.requestSubmit) {
          try { el.form.requestSubmit(); } catch (_) {}
        }
      }
      return { ok: true };
    }
    if (action.type === "scroll") {
      window.scrollBy(0, action.direction === "up" ? -innerHeight * 0.8 : innerHeight * 0.8);
      return { ok: true };
    }
    return { ok: false, error: "未知动作类型" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ===== 确定性查找替换（Google Docs 等）=====
// 对话框是普通 DOM。以下函数定位各控件、打标记、返回坐标，由 agent 用真实点击可靠操作。
// 注意：注入函数必须自包含。

// 定位已打开的查找替换对话框，给控件打上 data-ai-fr 标记，返回状态和各控件中心坐标。
// 已对照真实 Docs（2026-07，Material Design 3 新版对话框）验证：容器是 [role="dialog"]，
// 输入框带 aria-label，勾选框是原生 checkbox，按钮是真 <button>。同时保留旧版 .modal-dialog 兼容。
export function locateFindReplace() {
  try {
    const visible = (d) => {
      const s = getComputedStyle(d);
      return s.display !== "none" && s.visibility !== "hidden" && d.getBoundingClientRect().width > 50;
    };
    const candidates = [...document.querySelectorAll('[role="dialog"], .modal-dialog')].filter(visible);
    // 优先选标题含"查找和替换"的对话框，找不到再退回任意可见对话框
    const dlg = candidates.find((d) => /查找和替换|find\s*(and|&)\s*replace/i.test(d.innerText || "")) || candidates[0];
    if (!dlg) return { open: false };

    const center = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };

    // 查找/替换输入框：优先按 aria-label 认，兜底用"前两个可见文本框"
    const textInputs = [...dlg.querySelectorAll('input')].filter(
      (i) => (!i.type || i.type === "text") && i.getBoundingClientRect().width > 30
    );
    let findInput = textInputs.find((i) => /查找|find/i.test(i.getAttribute("aria-label") || ""));
    let replaceInput = textInputs.find((i) => /替换|replace/i.test(i.getAttribute("aria-label") || ""));
    if (!findInput) findInput = textInputs[0];
    if (!replaceInput) replaceInput = textInputs.find((i) => i !== findInput);
    if (!findInput) return { open: true, error: "对话框里找不到输入框" };
    findInput.setAttribute("data-ai-fr", "find");
    if (replaceInput) replaceInput.setAttribute("data-ai-fr", "replace");

    // 正则勾选框：checkbox 所在"行"的文字含"正则/regular"。
    // 只看离 checkbox 最近的、有文字的祖先，绝不爬到对话框层——否则整框都含"正则"会认错。
    let regexBox = null;
    for (const b of dlg.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
      let n = b.parentElement;
      for (let up = 0; up < 6 && n && n !== dlg; up++, n = n.parentElement) {
        const t = (n.innerText || "").trim();
        if (!t) continue;
        if (/正则|regular/i.test(t)) regexBox = b;
        break; // 找到最近有文字的祖先后就停，不再向上
      }
      if (regexBox) break;
    }
    if (regexBox) regexBox.setAttribute("data-ai-fr", "regex");

    // "全部替换"按钮（真实 Docs 是 <button>，disabled 属性直接可读）
    let allBtn = null;
    for (const b of dlg.querySelectorAll('button, [role="button"]')) {
      const t = (b.innerText || b.textContent || "").trim();
      if (/全部替换|replace all/i.test(t)) { allBtn = b; break; }
    }
    if (allBtn) allBtn.setAttribute("data-ai-fr", "replaceall");

    // 关闭按钮：aria-label=关闭/Close，或旧版 .modal-dialog-title-close
    const closeBtn =
      [...dlg.querySelectorAll("button, [role=\"button\"]")].find((b) => /关闭|close/i.test(b.getAttribute("aria-label") || "")) ||
      dlg.querySelector(".modal-dialog-title-close");
    if (closeBtn) closeBtn.setAttribute("data-ai-fr", "close");

    const regexChecked = regexBox
      ? (regexBox.checked === true || regexBox.getAttribute("aria-checked") === "true")
      : null;
    const allDisabled = allBtn
      ? (allBtn.disabled === true || allBtn.getAttribute("aria-disabled") === "true" || /disabled/.test(allBtn.className))
      : null;

    return {
      open: true,
      hasReplace: !!replaceInput,
      hasRegex: !!regexBox,
      regexChecked,
      hasReplaceAll: !!allBtn,
      allDisabled,
      coords: {
        find: center(findInput),
        replace: replaceInput ? center(replaceInput) : null,
        regex: regexBox ? center(regexBox) : null,
        replaceall: allBtn ? center(allBtn) : null,
        close: closeBtn ? center(closeBtn) : null
      },
      text: (dlg.innerText || "").replace(/\s+/g, " ").slice(-300)
    };
  } catch (e) {
    return { open: false, error: String(e) };
  }
}

// 定位 Docs 正文编辑区中心（发查找替换快捷键前需要先点它拿焦点）
export function locateDocsCanvas() {
  const el = document.querySelector(".kix-appview-editor") || document.querySelector('[role="document"]');
  if (!el) return { ok: false };
  const r = el.getBoundingClientRect();
  if (r.width < 50) return { ok: false };
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 300)) };
}

// 往打过标记的查找/替换输入框里填值
export function fillFindReplace(args) {
  try {
    const setVal = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const okFind = setVal('[data-ai-fr="find"]', args.find);
    const okReplace = args.replace === undefined ? true : setVal('[data-ai-fr="replace"]', args.replace);
    if (!okFind) return { ok: false, error: "找不到查找输入框（先调 locate）" };
    return { ok: true, replaceFilled: okReplace };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 无 debugger 时的降级：对打了标记的控件派发合成鼠标事件（closure 组件需要 mousedown/up）
export function clickMarked(kind) {
  try {
    const el = document.querySelector(`[data-ai-fr="${kind}"]`);
    if (!el) return { ok: false, error: "找不到标记控件 " + kind };
    for (const t of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 读取对话框当前文字（用于拿"已替换 N 处"的结果——结果通常显示在对话框末尾，取尾部）
export function readDialogText() {
  const dialogs = [...document.querySelectorAll(".modal-dialog")];
  const dlg = dialogs.find((d) => d.getBoundingClientRect().width > 50);
  return dlg ? (dlg.innerText || "").replace(/\s+/g, " ").slice(-300) : "";
}

// ===== 任务运行时的屏幕光效（类似 Claude in Chrome），颜色可由主题配置 =====
export function showGlow(color) {
  const c = color || "rgba(66,133,244,.6)";
  const existing = document.getElementById("__ai_glow__");
  if (existing && existing.dataset.c === c) return; // 已存在且颜色一致，幂等
  existing?.remove();
  document.getElementById("__ai_glow_style__")?.remove();
  const style = document.createElement("style");
  style.id = "__ai_glow_style__";
  style.textContent =
    "@keyframes __aiGlowPulse{0%,100%{opacity:.45}50%{opacity:.95}}" +
    "#__ai_glow__{position:fixed;inset:0;pointer-events:none;z-index:2147483646;" +
    `box-shadow:inset 0 0 26px 7px ${c};` +
    "animation:__aiGlowPulse 1.6s ease-in-out infinite;}";
  const el = document.createElement("div");
  el.id = "__ai_glow__";
  el.dataset.c = c;
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(el);
}

export function hideGlow() {
  document.getElementById("__ai_glow__")?.remove();
  document.getElementById("__ai_glow_style__")?.remove();
}

// ===== 页面浮窗：往网页里挂一个可拖动、可调大小的悬浮面板，内嵌扩展的 panel 页面 =====
export function mountFloatingPanel(panelUrl) {
  try {
    if (document.getElementById("__ai_float__")) return { ok: true, existed: true };

    const host = document.createElement("div");
    host.id = "__ai_float__";
    host.style.cssText =
      "position:fixed;top:80px;right:24px;width:380px;height:560px;box-sizing:border-box;" +
      "z-index:2147483647;background:#fff;border:1px solid #ddd;border-radius:12px;" +
      "box-shadow:0 8px 32px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;";

    // 标题栏（拖动把手）
    const bar = document.createElement("div");
    bar.style.cssText =
      "height:34px;flex:none;display:flex;align-items:center;gap:8px;padding:0 10px;" +
      "background:#f5f5f5;border-bottom:1px solid #e5e5e5;cursor:move;user-select:none;" +
      "font:12px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#666;";
    const title = document.createElement("span");
    title.textContent = "NL Browser Agent";
    title.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const closeBtn = document.createElement("div");
    closeBtn.style.cssText = "width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;";
    closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    closeBtn.addEventListener("mouseenter", () => (closeBtn.style.background = "#e5e5e5"));
    closeBtn.addEventListener("mouseleave", () => (closeBtn.style.background = "transparent"));
    closeBtn.addEventListener("click", () => host.remove());
    bar.appendChild(title);
    bar.appendChild(closeBtn);

    // 内容：扩展的 panel 页面
    const iframe = document.createElement("iframe");
    iframe.src = panelUrl;
    iframe.style.cssText = "flex:1;border:none;width:100%;";

    // 右下角缩放把手
    const grip = document.createElement("div");
    grip.style.cssText = "position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;display:flex;align-items:flex-end;justify-content:flex-end;";
    grip.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M14 8L8 14M14 12l-2 2" stroke="#bbb" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';

    host.appendChild(bar);
    host.appendChild(iframe);
    host.appendChild(grip);
    document.documentElement.appendChild(host);

    // 把 right 定位换成 left，方便拖动/缩放计算
    const pin = () => {
      const r = host.getBoundingClientRect();
      host.style.right = "auto";
      host.style.left = r.left + "px";
      host.style.top = r.top + "px";
      return r;
    };

    // 拖动
    let drag = null;
    bar.addEventListener("pointerdown", (e) => {
      if (closeBtn.contains(e.target)) return;
      const r = pin();
      drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
      iframe.style.pointerEvents = "none"; // 拖动期间别让 iframe 吃事件
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      host.style.left = Math.min(Math.max(0, drag.ox + e.clientX - drag.sx), innerWidth - 80) + "px";
      host.style.top = Math.min(Math.max(0, drag.oy + e.clientY - drag.sy), innerHeight - 40) + "px";
    });
    bar.addEventListener("pointerup", () => { drag = null; iframe.style.pointerEvents = "auto"; });

    // 缩放
    let rs = null;
    grip.addEventListener("pointerdown", (e) => {
      const r = pin();
      rs = { sx: e.clientX, sy: e.clientY, w: r.width, h: r.height };
      iframe.style.pointerEvents = "none";
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!rs) return;
      host.style.width = Math.max(300, rs.w + e.clientX - rs.sx) + "px";
      host.style.height = Math.max(360, rs.h + e.clientY - rs.sy) + "px";
    });
    grip.addEventListener("pointerup", () => { rs = null; iframe.style.pointerEvents = "auto"; });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
