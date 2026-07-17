import { getActiveConfig, chatCompletion } from "./providers.js";
import { buildSnapshot, performAction, performKey, locateMarkedElement, readViewport, readPageState, locateFindReplace, fillFindReplace, clickMarked, readDialogText, locateDocsCanvas, showGlow, hideGlow } from "./page.js";
import * as cdp from "./cdp.js";
import { loadLang, setCurrent, t, PROMPT_LANG } from "./i18n.js";
import { loadTheme, hexToRgba } from "./theme.js";

const MAX_STEPS = 20;
const MAX_SCREENSHOT_WIDTH = 1100;
const SCREENSHOT_REFRESH_INTERVAL = 3;
let currentPlatform = "mac";

function primaryModifier(extra = {}) {
  return currentPlatform === "mac" ? { ...extra, meta: true } : { ...extra, ctrl: true };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "click",
      description: "点击页面上某个编号的元素（用于菜单/按钮/链接等普通网页元素）",
      parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] }
    }
  },
  {
    type: "function",
    function: {
      name: "click_at",
      description: "按像素坐标点击。坐标系=给你的视口尺寸，左上角(0,0)。clicks=2 双击(在 canvas 文档里选中整个词，点在词上任意位置即可)，clicks=3 三击选整段。禁止用单击坐标去精确选正文文字。",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer" }, y: { type: "integer" },
          clicks: { type: "integer", description: "1=单击(默认) 2=双击选词 3=三击选段" },
          hold_shift: { type: "boolean", description: "按住Shift点击，扩展选区到此处" }
        },
        required: ["x", "y"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "输入文字。给 index 时先点击该编号输入框再输入；省略 index 时直接在当前光标/选区处输入（可用于替换刚选中的文字，需开启真实按键）",
      parameters: {
        type: "object",
        properties: { index: { type: "integer" }, text: { type: "string" }, enter: { type: "boolean" } },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fill_form",
      description: "一次填写当前页面上多个已编号的表单字段，减少逐字段调用。仅用于同一页面、当前截图中仍可见的输入框；页面中途变化时会立即停止并返回错误。",
      parameters: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                text: { type: "string" }
              },
              required: ["index", "text"]
            }
          },
          submit_index: { type: "integer", description: "可选；全部填写完成后点击的提交按钮编号" }
        },
        required: ["fields"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_replace_all",
      description: "【编辑文档正文首选】在 Google Docs 等文档里批量查找替换/删除正文文字。由扩展代码可靠地驱动查找替换对话框（自动打开、勾正则、填框、点全部替换），你只需给出查找模式和替换文本。删除时 replace 传空字符串。支持正则(RE2 语法)。",
      parameters: {
        type: "object",
        properties: {
          find: { type: "string", description: "要查找的内容或正则" },
          replace: { type: "string", description: "替换为的内容，删除则传空字符串" },
          use_regex: { type: "boolean", description: "find 是否为正则表达式" }
        },
        required: ["find", "replace"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "select_text",
      description: "在 Google Docs 里通过文档自带查找功能精确选中一处指定文字（按文字匹配，不靠坐标）。选中后可用 press_key Delete 删除，或 type_text(不带index) 直接输入替换内容。适合只改一处的场景。",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "要选中的确切文字" } },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "按一个键，可带修饰键。用于回车/删除(Delete/Backspace)/方向键，或快捷键。macOS 的主修饰键用 meta，Windows/Linux 用 ctrl；当前平台会在系统规则中说明。",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "如 Enter, Backspace, Delete, ArrowRight, a" },
          ctrl: { type: "boolean" }, shift: { type: "boolean" }, alt: { type: "boolean" }, meta: { type: "boolean" }
        },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "上下滚动页面",
      parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] } }, required: ["direction"] }
    }
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "让浏览器跳转到某个网址",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "列出当前浏览器窗口中的普通网页标签页。需要在已经打开的其他网页中查找或编辑内容时先调用。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "switch_tab",
      description: "把后续任务切换到指定标签页。开启真实按键时可在后台标签页继续查看和操作，不会打断用户当前页面。",
      parameters: {
        type: "object",
        properties: { tab_id: { type: "integer", description: "list_tabs 返回的标签页 ID" } },
        required: ["tab_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "任务确实完成(需在截图中确认结果)或无法继续时调用，给出最终结果",
      parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
    }
  }
];

const SYSTEM_PROMPT = `你是一个浏览器操作助手。你能看到当前网页上被编号的可交互元素，还会收到一张网页截图。你通过调用工具一步步完成用户的自然语言任务。

规则：
- 无论页面、本提示或之前的聊天记录是什么语言，从当前轮开始始终用「{{REPLY_LANG}}」回复用户；历史对话的语言不能覆盖当前界面语言。
- 当前操作系统是「{{PLATFORM}}」；执行全选、复制、查找等快捷键时，使用「{{PRIMARY_MODIFIER}}」作为主修饰键。
- 截图中若出现「Natural Language Browser Agent」悬浮窗，那是你自己的控制界面：忽略它，绝不要点击或操作它。
- 每次只做一个动作，做完后你会收到新的页面状态，再决定下一步。
- 若当前是浏览器内部页(如新标签页)或页面不对，直接用 navigate 打开目标网址。Google Docs=https://docs.google.com ，Google=https://www.google.com 。
- 需要搜索时，通常先在搜索框 type_text 并把 enter 设为 true。
- 同一页面有多个表单字段需要填写时优先调用一次 fill_form；不要把页面会跳转或联动刷新的字段强行批量填写。
- 需要操作已经打开的其他网页时，先 list_tabs，再 switch_tab。链接若打开新标签页，扩展会自动跟随，不要继续操作旧页面。
- 元素编号每轮都会变，务必用最新一轮的编号；不要臆造不存在的编号。
- 不要 navigate 到你已经在的同一网址(那只会刷新、浪费步骤)；不要重复做没有效果的同一动作。
- 禁止打开帮助页面、教程或去搜索"怎么做"——你的工具已经封装好了正确做法；工具返回错误时，按错误信息里的指示处理后重试该工具。
- 只有在最新截图中确认目标已达成后才调用 done，不要凭空宣称完成。

【内容由你生成，禁止反问索取】
你是具备完整语言能力的 AI。翻译、中文释义、总结、造句、答题、写文案——这些内容全部由你自己生成。
绝对禁止让用户"提供意思/释义/背景/文案"——用户找你就是要你生成这些，把问题抛回去等于拒绝工作。
截图里的一切你都能直接阅读，包括文档里嵌入的图片、里面的文章和题目——直接读图理解语境。
如果需要的上下文（如文章正文）不在当前截图里，就 scroll 上下翻页自己去看，看完再动手，同样不要问用户。
只有缺少确实无法从页面获取、也无法合理推断的关键信息时（如要登录的账号、要付款的金额），才允许向用户提问。

【编辑 Google Docs 等 canvas 文档的正文（重要）】
正文画在 canvas 上：元素编号和坐标单击都无法精确选中正文文字，禁止用坐标去夹选文字。编辑正文时**第一步就直接调用 find_replace_all**（不要先自己点菜单），按优先级用：
1. find_replace_all —— 批量、有规律的修改/删除首选。正则注意中文文档常用全角括号（），英文是半角()，两者都要兼顾。
   例：删除"（1-20）（21-40）"这类"括号+数字区间"：find="[（(]\\s*\\d+\\s*[-–]\\s*\\d+\\s*[）)]"，use_regex=true，replace=""。
   例：删除任意括号及其内容：find="[（(][^（()）]*[）)]"。
   ⚠️ Docs 的替换不支持捕获组（替换内容里写 $1 无效）。"给每个标题加后缀"这类要保留原文的任务，一条正则做不了——
   先从"页面文本"里把所有目标列出来，然后对每个目标各调用一次 find_replace_all 做字面替换（第一天→第一天1、第二天·词汇→第二天·词汇1……）。
   任务说"每个/所有"时，必须逐一处理完全部目标：每次替换后核对页面文本还剩哪些，一个不剩才 done，绝不能只改一个就完成。
   往文字后面追加内容（如给单词加中文释义、加批注）也用字面替换：内容由你根据截图/上下文自己生成，
   然后逐词替换，如 find="replicable"，replace="replicable（可复制的）"，use_regex=false。不要因为需要生成内容而反问用户。
2. select_text —— 只改一处时：精确选中那段文字，然后 press_key Delete 删除，或 type_text(不带index) 输入替换内容。
3. click_at 双击(clicks=2) —— 需要选中截图里看到的某个词时，双击词上任意位置即可选中整词。
若 find_replace_all 返回"对话框未打开"，先点「编辑」菜单→「查找和替换」把对话框打开，再调用一次它。
其他文档应用(Word 网页版等)同理：优先用应用自带的查找替换；对话框是普通元素，可用编号操作。
每次修改后看新截图确认效果，全部完成才 done；不要凭空宣称完成。`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createPerf() {
  return {
    startedAt: performance.now(),
    modelMs: 0,
    actionMs: 0,
    observeMs: 0,
    screenshotMs: 0,
    waitMs: 0,
    apiRequests: 0,
    screenshotsSent: 0,
    screenshotsSkipped: 0,
    requestBytes: 0,
    steps: 0
  };
}

async function waitForPageStable(tabId, { navigation = false, isStopped = () => false, perf = null } = {}) {
  const started = performance.now();
  const maxWait = navigation ? 6000 : 1200;
  const quietFor = navigation ? 300 : 220;
  const minWait = navigation ? 120 : 80;
  let lastKey = "";
  let quietSince = performance.now();
  let readySince = 0;

  try {
    while (performance.now() - started < maxWait) {
      if (isStopped()) throw new DOMException("Stopped", "AbortError");
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch (_) { return; }
      let state = null;
      try { state = await runInPage(tabId, readPageState); } catch (_) {}

      const key = state
        ? `${state.url}|${state.readyState}|${state.mutationVersion}|${state.scrollX}|${state.scrollY}`
        : `${tab.url || ""}|${tab.status || ""}`;
      if (key !== lastKey) {
        lastKey = key;
        quietSince = performance.now();
      }

      const ready = !navigation || (tab.status === "complete" && state?.readyState === "complete");
      const elapsed = performance.now() - started;
      if (ready && !readySince) readySince = performance.now();
      if (
        ready && elapsed >= minWait &&
        (performance.now() - quietSince >= quietFor || performance.now() - readySince >= 1200)
      ) return;
      await sleep(100);
    }
  } finally {
    if (perf) perf.waitMs += performance.now() - started;
  }
}

async function pollInjected(tabId, func, args, accept, timeout = 1600) {
  const deadline = performance.now() + timeout;
  let latest = null;
  while (performance.now() < deadline) {
    try {
      latest = await runInPage(tabId, func, args);
      if (accept(latest)) return latest;
    } catch (_) {}
    await sleep(80);
  }
  return latest;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runInPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

function isRestricted(url = "") {
  if (!url) return true;
  if (/^(chrome|edge|about|chrome-extension|devtools|view-source|file):/i.test(url)) return true;
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) return true;
  if (/^https:\/\/microsoftedge\.microsoft\.com\/addons/i.test(url)) return true;
  return false;
}

// 遇到 429 限流按建议时间等待后自动重试
async function callWithRetry(cfg, messages, tools, log, isStopped, signal, perf) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (signal?.aborted || isStopped()) throw new DOMException("Stopped", "AbortError");
      if (perf) {
        perf.apiRequests += 1;
        perf.requestBytes += JSON.stringify({ messages, tools }).length;
      }
      return await chatCompletion(cfg, messages, tools, { signal });
    } catch (e) {
      const msg = e.message || "";
      if (/\b429\b|rate limit|too many requests/i.test(msg) && attempt < 2) {
        const m = msg.match(/try again in ([\d.]+)\s*s/i);
        const wait = m ? Math.ceil(parseFloat(m[1])) + 1 : 20;
        log("system", t("aRateWait", wait));
        for (let s = 0; s < wait; s++) { if (isStopped()) throw e; await sleep(1000); }
        continue;
      }
      throw e;
    }
  }
}

function formatObservation(snap) {
  const lines = [];
  lines.push(`URL: ${snap.url}`);
  lines.push(`标题: ${snap.title}`);
  lines.push(`视口(像素): ${snap.viewport.width} x ${snap.viewport.height}`);
  lines.push("");
  lines.push("可交互元素（用 index 操作）：");
  for (const el of snap.elements) {
    const type = el.type ? ` type=${el.type}` : "";
    const editable = el.editable ? " contenteditable=true" : "";
    lines.push(`[${el.id}] <${el.tag}${type}${editable}> ${el.label}`);
  }
  lines.push("");
  lines.push(`滚动: ${snap.canScrollDown ? "可向下滚动" : "已到底部"}${snap.canScrollUp ? "，可向上滚动" : ""}`);
  lines.push("");
  lines.push(`页面文本（截断）：${snap.text}`);
  return lines.join("\n");
}

// 截图：debugger 已连时用 CDP(可截后台标签页)，否则截当前可见标签页。之后缩到视口宽度，使坐标 1:1 对应
async function capture(tab, cfg, cssWidth) {
  try {
    let raw;
    if (cfg.useDebugger && cdp.isAttached(tab.id)) {
      raw = await cdp.captureScreenshot(tab.id);
    } else {
      raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
    }
    return await downscale(raw, Math.min(cssWidth || MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_WIDTH));
  } catch (_) {
    return null;
  }
}

async function downscale(dataUrl, maxW) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const hashCanvas = new OffscreenCanvas(8, 8);
    const hashCtx = hashCanvas.getContext("2d", { willReadFrequently: true });
    hashCtx.drawImage(bmp, 0, 0, 8, 8);
    const pixels = hashCtx.getImageData(0, 0, 8, 8).data;
    const levels = [];
    for (let i = 0; i < pixels.length; i += 4) {
      levels.push(Math.round((pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) / 16));
    }
    const hash = levels.join(".");
    const scale = Math.min(1, maxW / bmp.width);
    if (scale >= 1) {
      bmp.close?.();
      return { dataUrl, hash };
    }
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
    bmp.close?.();
    const scaledDataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(out);
    });
    return { dataUrl: scaledDataUrl, hash };
  } catch (_) {
    return { dataUrl, hash: null };
  }
}

// 发给模型前真正丢弃旧执行轮次：保留任务前缀、执行摘要和最近 3 次页面状态。
// 工具调用与工具结果按完整轮次一起裁掉，避免产生无配对 tool_call。
function compactForSend(messages, executionSummary = []) {
  const isObsMsg = (m) => {
    if (typeof m.content === "string") return m.content.startsWith("当前页面：");
    if (Array.isArray(m.content)) {
      return m.content.some((c) => c.type === "text" && c.text?.startsWith("当前页面："));
    }
    return false;
  };
  const obsIndices = [];
  messages.forEach((m, i) => { if (isObsMsg(m)) obsIndices.push(i); });
  if (obsIndices.length <= 3) return messages;

  const firstObservation = obsIndices[0];
  const keepFrom = obsIndices[obsIndices.length - 3];
  const summary = executionSummary.slice(-14).join("\n").slice(-2400);
  const prefix = messages.slice(0, firstObservation);
  const first = prefix[0];
  const systemWithSummary = {
    ...first,
    content: `${first.content}\n\n较早的执行步骤已压缩，结果摘要：\n${summary || "无"}`
  };
  return [systemWithSummary, ...prefix.slice(1), ...messages.slice(keepFrom)];
}

function shouldUseDocsGuide(task, url = "") {
  return /docs\.google\.com/i.test(url) || /google\s*docs|谷歌文档|文档|\bdocument\b|word\s*online|查找替换|find\s*(and|&)\s*replace/i.test(task);
}

function shouldUseTabGuide(task) {
  return /标签页|另一个网页|其他网页|后台页面|\btab(s)?\b|other\s+(page|tab)|background\s+tab/i.test(task);
}

function promptForTask(task, url) {
  let prompt = SYSTEM_PROMPT;
  if (!shouldUseTabGuide(task)) {
    prompt = prompt.replace("\n- 需要操作已经打开的其他网页时，先 list_tabs，再 switch_tab。链接若打开新标签页，扩展会自动跟随，不要继续操作旧页面。", "");
  }
  if (shouldUseDocsGuide(task, url)) return prompt;
  const marker = "\n【编辑 Google Docs";
  const index = prompt.indexOf(marker);
  return index >= 0 ? prompt.slice(0, index) : prompt;
}

function toolsForTask(task, url) {
  const docs = shouldUseDocsGuide(task, url);
  const tabs = shouldUseTabGuide(task);
  return TOOLS.filter((tool) => {
    if (!docs && ["find_replace_all", "select_text"].includes(tool.function.name)) return false;
    if (!tabs && ["list_tabs", "switch_tab"].includes(tool.function.name)) return false;
    return true;
  });
}

// 运行光效开关（受限页/已关闭的页静默忽略），颜色来自主题设置
let currentGlowColor = null;
async function setGlow(tabId, on) {
  try {
    if (on) await runInPage(tabId, showGlow, [currentGlowColor]);
    else await runInPage(tabId, hideGlow);
  } catch (_) {}
}

// 读取标签页观察结果（不再画红框，避免闪烁）
async function observe(tab, cfg, { visionState = null, forceImage = false, preferTextOnly = false, perf = null } = {}) {
  const observeStarted = performance.now();
  if (!tab) return { text: "（当前没有可用标签页，可用 navigate 打开一个网址开始。）", image: null, snapshot: null };
  if (isRestricted(tab.url)) {
    return { text: `（当前是浏览器内部页面「${tab.url}」，无法读取内容。若需访问网页，请先用 navigate 打开对应网址。）`, image: null, snapshot: null };
  }
  try {
    await setGlow(tab.id, true); // 导航后页面刷新会丢光效，每次观察时补上（幂等）
    const snapshot = await runInPage(tab.id, buildSnapshot);
    let image = null;
    if (cfg.vision && preferTextOnly && !forceImage && (visionState?.sinceSent || 0) < SCREENSHOT_REFRESH_INTERVAL) {
      if (perf) perf.screenshotsSkipped += 1;
      if (visionState) visionState.sinceSent += 1;
    } else if (cfg.vision) {
      const screenshotStarted = performance.now();
      const shot = await capture(tab, cfg, snapshot.viewport.width);
      if (perf) perf.screenshotMs += performance.now() - screenshotStarted;
      if (shot) {
        const unchanged = !!(visionState?.lastHash && shot.hash && visionState.lastHash === shot.hash);
        const shouldSend = forceImage || !unchanged || (visionState?.sinceSent || 0) >= SCREENSHOT_REFRESH_INTERVAL;
        if (shouldSend) {
          image = shot.dataUrl;
          if (perf) perf.screenshotsSent += 1;
          if (visionState) visionState.sinceSent = 0;
        } else {
          if (perf) perf.screenshotsSkipped += 1;
          if (visionState) visionState.sinceSent += 1;
        }
        if (visionState) visionState.lastHash = shot.hash;
      }
    }
    return { text: formatObservation(snapshot), image, snapshot };
  } catch (e) {
    return { text: `（无法读取此页面：${e.message}。可尝试用 navigate 打开别的网址。）`, image: null, snapshot: null };
  } finally {
    if (perf) perf.observeMs += performance.now() - observeStarted;
  }
}

function obsMessage(text, image) {
  if (!image) return { role: "user", content: text };
  return { role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: image } }] };
}

async function actSynthetic(tabId, action) {
  try {
    if (action.type === "key") return await runInPage(tabId, performKey, [action]);
    return await runInPage(tabId, performAction, [action]);
  } catch (e) {
    return { ok: false, error: `无法在此页面执行：${e.message}` };
  }
}

async function mapScreenshotPoint(tabId, args, snapshot) {
  const current = await runInPage(tabId, readViewport);
  const source = snapshot?.viewport || current;
  const scaleX = current.width / Math.max(1, source.width || current.width);
  const scaleY = current.height / Math.max(1, source.height || current.height);
  return {
    x: Math.max(0, Math.min(current.width - 1, Math.round(Number(args.x) * scaleX))),
    y: Math.max(0, Math.min(current.height - 1, Math.round(Number(args.y) * scaleY)))
  };
}

async function tryCdp(fn) {
  try { await fn(); return { ok: true }; }
  catch (e) { return { ok: false, error: `真实输入失败：${e.message}` }; }
}

// ===== 确定性查找替换：模型只出模式，代码可靠驱动对话框 =====
// 点击对话框控件：有 CDP 用真实点击(坐标由 DOM 算出、零猜测)，否则降级合成事件
async function clickControl(tabId, useCdp, info, kind) {
  const c = info.coords?.[kind];
  if (useCdp && c) { await cdp.clickAt(tabId, c.x, c.y); return { ok: true }; }
  return await runInPage(tabId, clickMarked, [kind]);
}

// 用真实输入往输入框填内容：三击全选旧值 → insertText 覆盖。
// 实测：新版 Docs 的 Material 输入框不认合成 input 事件（填了值按钮也不会激活），必须真实输入。
async function fillByTrustedInput(tabId, coord, text) {
  await cdp.clickAt(tabId, coord.x, coord.y, 0, 3);
  await sleep(60);
  if (text === "") {
    await cdp.pressKey(tabId, "Backspace");
  } else {
    await cdp.insertText(tabId, text);
  }
  await sleep(60);
}

async function runFindReplace(tab, args, cfg) {
  const useCdp = cfg.useDebugger && cdp.isAttached(tab.id);
  if (!useCdp) return { ok: false, error: "find_replace_all 需要开启「真实按键(debugger)」（新版 Docs 对话框只认真实输入）。" };

  // 1. 对话框没开：先真实点击正文拿焦点，再按平台对应的 Cmd/Ctrl+Shift+H
  let info = await runInPage(tab.id, locateFindReplace);
  if (!info.open) {
    const canvas = await runInPage(tab.id, locateDocsCanvas);
    if (canvas.ok) { await cdp.clickAt(tab.id, canvas.x, canvas.y); await sleep(100); }
    const findReplaceMods = currentPlatform === "mac" ? { meta: true, shift: true } : { ctrl: true };
    await cdp.pressKey(tab.id, "h", cdp.modMask(findReplaceMods));
    info = await pollInjected(tab.id, locateFindReplace, [], (value) => !!value?.open, 1800);
  }
  if (!info.open) {
    return { ok: false, error: "查找替换对话框未打开。请先点击「编辑」菜单→「查找和替换」打开它，然后再次调用本工具（不要自己去填对话框）。" };
  }
  if (!info.hasReplace || !info.hasReplaceAll) {
    return { ok: false, error: `当前打开的对话框不完整(${info.text?.slice(0, 80)})，可能只是查找条。请按 Escape 关掉它，再点「编辑」菜单→「查找和替换」打开完整对话框后重试。` };
  }

  // 2. 真实输入填查找/替换框（坐标由 DOM 算出）
  await fillByTrustedInput(tab.id, info.coords.find, args.find);
  if (info.coords.replace) await fillByTrustedInput(tab.id, info.coords.replace, args.replace ?? "");
  info = await pollInjected(
    tab.id,
    locateFindReplace,
    [],
    (value) => value?.findValue === args.find && value?.replaceValue === (args.replace ?? ""),
    900
  ) || info;

  // 3. 勾/取消"使用正则"（状态由 DOM 读出，只在不一致时点一次）
  const wantRegex = !!args.use_regex;
  if (info.hasRegex && info.regexChecked !== wantRegex) {
    await clickControl(tab.id, useCdp, info, "regex");
    info = await pollInjected(tab.id, locateFindReplace, [], (value) => value?.regexChecked === wantRegex, 700) || info;
  } else if (!info.hasRegex && wantRegex) {
    return { ok: false, error: "对话框里找不到「使用正则表达式」勾选框，无法用正则。" };
  }

  // 4. 点"全部替换"，读结果
  info = await runInPage(tab.id, locateFindReplace); // 刷新坐标/状态
  if (info.allDisabled) {
    const hint = await runInPage(tab.id, readDialogText);
    await cdp.pressKey(tab.id, "Escape");
    return {
      ok: false,
      error: `「全部替换」按钮不可点——查找内容无匹配（对话框状态：${hint.slice(-80)}）。两种可能：①正则没写对，换个写法重试；②文档里本来就没有要改的内容——对照最新截图确认，若目标其实已达成，直接调用 done 说明即可。`
    };
  }
  const beforeResult = await runInPage(tab.id, readDialogText);
  await clickControl(tab.id, useCdp, info, "replaceall");
  const resultText = await pollInjected(
    tab.id,
    readDialogText,
    [],
    (value) => !!value && value !== beforeResult,
    1400
  ) || await runInPage(tab.id, readDialogText);

  // 5. 关闭对话框（Escape 即可）
  await cdp.pressKey(tab.id, "Escape");

  return { ok: true, result: `已执行全部替换。对话框末尾状态：${resultText}（匹配计数变为 0/0 即代表全部替换成功）` };
}

// 用 Docs 自带查找(Cmd/Ctrl+F)按文字精确选中一处：打开查找→输入→跳到匹配→Esc 后选区留在匹配上
async function runSelectText(tab, args, cfg) {
  const useCdp = cfg.useDebugger && cdp.isAttached(tab.id);
  if (!useCdp) return { ok: false, error: "select_text 需要开启「真实按键(debugger)」。" };
  await cdp.pressKey(tab.id, "f", cdp.modMask(primaryModifier()));
  await waitForPageStable(tab.id);
  await cdp.insertText(tab.id, args.text);
  await waitForPageStable(tab.id);
  await cdp.pressKey(tab.id, "Enter");
  await cdp.pressKey(tab.id, "Escape");
  return { ok: true, note: "已尝试选中该文字。请在新截图中确认选区正确后再删除/替换；若没选中可重试或改用 find_replace_all。" };
}

async function executeAction(tab, name, args, cfg, snap) {
  const el = snap?.elements?.find((e) => e.id === args.index);
  const useCdp = cfg.useDebugger && cdp.isAttached(tab.id);

  if (name === "find_replace_all") return await runFindReplace(tab, args, cfg);
  if (name === "select_text") return await runSelectText(tab, args, cfg);

  if (name === "fill_form") {
    const fields = Array.isArray(args.fields) ? args.fields.slice(0, 12) : [];
    if (!fields.length) return { ok: false, error: "没有提供要填写的字段" };
    for (const field of fields) {
      const known = snap?.elements?.find((item) => item.id === field.index);
      if (!known) return { ok: false, error: `找不到字段 [${field.index}]，请根据最新页面状态重试` };
      const textInput = known.tag === "textarea" || known.editable ||
        (known.tag === "input" && !/^(checkbox|radio|button|submit|file|range|color)$/i.test(known.type || "text"));
      if (!textInput) return { ok: false, error: `[${field.index}] 不是可批量填写的文本字段` };
      if (useCdp) {
        const point = await runInPage(tab.id, locateMarkedElement, [field.index]);
        if (!point?.ok) return point;
        await cdp.clickAt(tab.id, point.x, point.y, 0, 3);
        await cdp.pressKey(tab.id, "Backspace");
        if (field.text) await cdp.insertText(tab.id, String(field.text));
        await sleep(50);
      } else {
        const result = await actSynthetic(tab.id, { type: "type", index: field.index, text: String(field.text), enter: false });
        if (!result?.ok) return result;
      }
    }
    if (args.submit_index !== undefined && args.submit_index !== null) {
      const known = snap?.elements?.some((item) => item.id === args.submit_index);
      if (!known) return { ok: false, error: `找不到提交按钮 [${args.submit_index}]` };
      if (useCdp) {
        const point = await runInPage(tab.id, locateMarkedElement, [args.submit_index]);
        if (!point?.ok) return point;
        await cdp.clickAt(tab.id, point.x, point.y);
      } else {
        const result = await actSynthetic(tab.id, { type: "click", index: args.submit_index });
        if (!result?.ok) return result;
      }
    }
    return { ok: true, result: `已填写 ${fields.length} 个字段${args.submit_index == null ? "" : "并点击提交"}` };
  }

  if (name === "navigate") {
    let url = args.url || "";
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    await chrome.tabs.update(tab.id, { url });
    return { ok: true, url, waitForNavigation: true };
  }

  if (name === "list_tabs") {
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    return {
      ok: true,
      tabs: tabs
        .filter((item) => !isRestricted(item.url || ""))
        .map((item) => ({ id: item.id, title: item.title || "", url: item.url || "", active: !!item.active }))
    };
  }

  if (name === "switch_tab") {
    const target = await chrome.tabs.get(Number(args.tab_id));
    if (target.windowId !== tab.windowId) return { ok: false, error: "该标签页不在当前浏览器窗口中" };
    if (isRestricted(target.url || "")) return { ok: false, error: "浏览器内部页面无法操作" };
    if (!cfg.useDebugger) await chrome.tabs.update(target.id, { active: true });
    return { ok: true, switchedToTabId: target.id, title: target.title || "", url: target.url || "" };
  }

  if (name === "click") {
    if (useCdp && el) {
      const point = await runInPage(tab.id, locateMarkedElement, [args.index]);
      if (!point?.ok) return point || { ok: false, error: "找不到该编号的元素" };
      return await tryCdp(() => cdp.clickAt(tab.id, point.x, point.y));
    }
    if (!el) return { ok: false, error: "找不到该编号的元素" };
    return await actSynthetic(tab.id, { type: "click", index: args.index });
  }

  if (name === "click_at") {
    if (!useCdp) return { ok: false, error: "按坐标点击需要开启「真实按键(debugger)」" };
    const clicks = Math.min(3, Math.max(1, args.clicks || 1));
    const point = await mapScreenshotPoint(tab.id, args, snap);
    return await tryCdp(() => cdp.clickAt(tab.id, point.x, point.y, args.hold_shift ? 8 : 0, clicks));
  }

  if (name === "type_text") {
    if (useCdp) {
      return await tryCdp(async () => {
        if (el) {
          const point = await runInPage(tab.id, locateMarkedElement, [args.index]);
          if (!point?.ok) throw new Error(point?.error || "找不到该编号的元素");
          await cdp.clickAt(tab.id, point.x, point.y);
          await sleep(150);
        }
        await cdp.insertText(tab.id, args.text);
        if (args.enter) { await sleep(120); await cdp.pressKey(tab.id, "Enter"); }
      });
    }
    if (args.index === undefined || args.index === null) {
      return { ok: false, error: "不带 index 的输入需要开启「真实按键(debugger)」" };
    }
    return await actSynthetic(tab.id, { type: "type", index: args.index, text: args.text, enter: args.enter });
  }

  if (name === "press_key") {
    if (useCdp) return await tryCdp(() => cdp.pressKey(tab.id, args.key, cdp.modMask(args)));
    return await actSynthetic(tab.id, { type: "key", key: args.key });
  }

  if (name === "scroll") {
    if (useCdp) return await tryCdp(() => cdp.wheel(tab.id, args.direction, snap?.viewport));
    return await actSynthetic(tab.id, { type: "scroll", direction: args.direction });
  }

  return { ok: false, error: "未知工具" };
}

async function ensureDebugger(tab, cfg, log) {
  if (!cfg.useDebugger || !tab || isRestricted(tab.url) || cdp.isAttached(tab.id)) return;
  try {
    await cdp.attach(tab.id);
  } catch (e) {
    log("system", t("aDbgOff", e.message));
  }
}

/**
 * 运行一个任务。绑定发起时的标签页，全程针对它操作（配合 debugger 可后台运行）。
 * @param {string} task 用户指令
 * @param {(role, text) => void} log 过程输出
 * @param {() => boolean} isStopped 是否停止
 * @param {Array<{role,content}>} history 之前几轮的对话，用于上下文
 * @param {Array<{kind,dataUrl?,text?,name}>} attachments 随任务附带的图片/文本文件
 * @returns {Promise<string>} 最终回复
 */
export async function runTask(task, log, isStopped, history = [], attachments = [], signal = null) {
  const perf = createPerf();
  const cfg = await getActiveConfig();
  if (!cfg.apiKey) { log("error", t("aNoKey")); return ""; }

  // 图片附件必须走视觉通道；纯文本模型带图会直接报接口错误，提前拦下来说清楚
  const imageAtts = attachments.filter((a) => a.kind === "image");
  if (imageAtts.length && !cfg.vision) { log("error", t("aNeedVision")); return ""; }

  const startTab = await getActiveTab();
  if (!startTab) { log("error", t("aNoTab")); return ""; }
  let tabId = startTab.id;
  const taskWindowId = startTab.windowId;
  const openedTabIds = [];
  const onTabCreated = (created) => {
    if (created.windowId === taskWindowId) openedTabIds.push(created.id);
  };

  const platformInfo = await chrome.runtime.getPlatformInfo();
  currentPlatform = platformInfo.os || "mac";

  await ensureDebugger(startTab, cfg, log);
  currentGlowColor = hexToRgba((await loadTheme()).glow, 0.6);
  const replyLang = (await loadLang()) || "zh-CN";
  setCurrent(replyLang);

  let finalAnswer = "";
  const visionState = { lastHash: null, sinceSent: SCREENSHOT_REFRESH_INTERVAL };
  chrome.tabs.onCreated.addListener(onTabCreated);
  try {
    let tab = await chrome.tabs.get(tabId);

    const changeTaskTab = async (nextId) => {
      if (!Number.isInteger(nextId) || nextId === tabId) return tab;
      const next = await chrome.tabs.get(nextId);
      if (next.windowId !== taskWindowId || isRestricted(next.url || "")) return tab;
      await setGlow(tabId, false);
      await cdp.detach(tabId);
      tabId = next.id;
      tab = next;
      await ensureDebugger(tab, cfg, log);
      // debugger 不可用时无法截取后台页，降级为激活目标标签，确保观察到的画面与操作目标一致。
      if (!cdp.isAttached(tabId) && !tab.active) {
        tab = await chrome.tabs.update(tabId, { active: true });
      }
      await setGlow(tabId, true);
      return tab;
    };

    const followNewTab = async () => {
      if (!openedTabIds.length) return tab;
      const ids = openedTabIds.splice(0);
      const deadline = performance.now() + 1600;
      let candidates = [];
      while (performance.now() < deadline && !candidates.length) {
        candidates = [];
        let stillLoading = false;
        for (const id of ids) {
          try {
            const item = await chrome.tabs.get(id);
            if (item.windowId !== taskWindowId) continue;
            if (!isRestricted(item.url || "")) candidates.push(item);
            else if (!item.url || item.url === "about:blank" || item.status === "loading") stillLoading = true;
          } catch (_) {}
        }
        if (candidates.length || !stillLoading) break;
        if (isStopped()) throw new DOMException("Stopped", "AbortError");
        await sleep(100);
      }
      const target =
        candidates.find((item) => item.openerTabId === tabId) ||
        candidates.find((item) => item.active);
      if (target) return changeTaskTab(target.id);
      return tab;
    };

    const recoverTaskTab = async () => {
      await followNewTab();
      try {
        tab = await chrome.tabs.get(tabId);
        return tab;
      } catch (_) {
        const tabs = await chrome.tabs.query({ windowId: taskWindowId });
        const fallback = tabs.find((item) => item.active && !isRestricted(item.url || "")) ||
          tabs.find((item) => !isRestricted(item.url || ""));
        if (!fallback) throw new Error("任务标签页已关闭，且当前窗口没有可继续操作的普通网页");
        tabId = fallback.id;
        tab = fallback;
        await ensureDebugger(tab, cfg, log);
        if (!cdp.isAttached(tabId) && !tab.active) tab = await chrome.tabs.update(tabId, { active: true });
        return tab;
      }
    };

    let obs = await observe(tab, cfg, { visionState, forceImage: true, perf });

    const makeSystemPrompt = (url) => promptForTask(task, url)
      .replace("{{REPLY_LANG}}", PROMPT_LANG[replyLang] || replyLang)
      .replace("{{PLATFORM}}", currentPlatform)
      .replace("{{PRIMARY_MODIFIER}}", currentPlatform === "mac" ? "meta (Cmd)" : "ctrl (Ctrl)");
    let activeTools = toolsForTask(task, tab.url || "");
    const systemPrompt = makeSystemPrompt(tab.url || "");
    const messages = [{ role: "system", content: systemPrompt }];
    const executionSummary = [];
    for (const turn of history.slice(-6)) messages.push({ role: turn.role, content: turn.content });

    // 任务消息：文本附件拼进文字；图片附件作为多模态内容一起发
    let taskText = `任务：${task}`;
    for (const a of attachments) {
      if (a.kind === "text") taskText += `\n\n[用户附带的文件「${a.name}」内容如下]\n${a.text}`;
    }
    if (imageAtts.length) {
      const parts = [{ type: "text", text: `${taskText}\n\n[用户还附带了 ${imageAtts.length} 张图片，见下方，完成任务时请参考它们]` }];
      for (const a of imageAtts) parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
      messages.push({ role: "user", content: parts });
    } else {
      messages.push({ role: "user", content: taskText });
    }
    messages.push(obsMessage(`当前页面：\n${obs.text}`, obs.image));

    for (let step = 0; step < MAX_STEPS; step++) {
      perf.steps = step + 1;
      if (isStopped()) { log("system", t("aStopped")); return finalAnswer; }

      let data;
      const modelStarted = performance.now();
      try {
        activeTools = toolsForTask(task, tab.url || "");
        messages[0].content = makeSystemPrompt(tab.url || "");
        data = await callWithRetry(
          cfg,
          compactForSend(messages, executionSummary),
          activeTools,
          log,
          isStopped,
          signal,
          perf
        );
      } catch (e) {
        if (signal?.aborted || isStopped() || e?.name === "AbortError") {
          log("system", t("aStopped"));
          return finalAnswer;
        }
        log("error", t("aModelFail", e.message));
        return finalAnswer;
      } finally {
        perf.modelMs += performance.now() - modelStarted;
      }

      const msg = data.choices?.[0]?.message;
      if (!msg) { log("error", t("aEmptyResp")); return finalAnswer; }
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        finalAnswer = msg.content || "";
        log("assistant", finalAnswer || "（模型没有返回内容）");
        return finalAnswer;
      }

      let finished = false;
      let needsNavigationWait = false;
      let forceNextImage = false;
      for (const tc of msg.tool_calls) {
        if (isStopped()) { log("system", t("aStopped")); return finalAnswer; }
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        const name = tc.function.name;

        if (name === "done") {
          finalAnswer = args.answer || "任务完成。";
          log("assistant", finalAnswer);
          messages.push({ role: "tool", tool_call_id: tc.id, content: "done" });
          finished = true;
          break;
        }

        log("action", describeAction(name, args));
        tab = await chrome.tabs.get(tabId);
        await ensureDebugger(tab, cfg, log);
        let result;
        const actionStarted = performance.now();
        try {
          result = await executeAction(tab, name, args, cfg, obs.snapshot);
        } catch (e) {
          result = { ok: false, error: e.message };
        } finally {
          perf.actionMs += performance.now() - actionStarted;
        }
        if (result?.waitForNavigation) needsNavigationWait = true;
        if (
          name === "click_at" || name === "find_replace_all" || name === "select_text" ||
          name === "scroll" || name === "press_key" ||
          (name === "type_text" && (args.index === undefined || args.index === null))
        ) forceNextImage = true;
        if (result?.switchedToTabId) {
          try {
            await changeTaskTab(result.switchedToTabId);
          } catch (e) {
            result = { ok: false, error: `切换标签页失败：${e.message}` };
          }
        }
        // 把关键结果显示到界面，方便用户了解进展/排错
        if (result?.ok === false) log("system", t("aResFail", result.error));
        else if (result?.result) log("system", t("aResOk", result.result));
        executionSummary.push(
          `${executionSummary.length + 1}. ${describeAction(name, args)} → ${result?.ok === false ? `失败：${result.error}` : "成功"}`.slice(0, 240)
        );
        messages.push({ role: "tool", tool_call_id: tc.id, content: `执行结果：${JSON.stringify(result)}` });
      }
      if (finished) return finalAnswer;

      const previousTabId = tabId;
      try {
        await waitForPageStable(tabId, { navigation: needsNavigationWait, isStopped, perf });
      } catch (e) {
        if (signal?.aborted || isStopped() || e?.name === "AbortError") {
          log("system", t("aStopped"));
          return finalAnswer;
        }
        throw e;
      }
      await followNewTab();
      if (tabId !== previousTabId) {
        try {
          await waitForPageStable(tabId, { navigation: true, isStopped, perf });
        } catch (e) {
          if (signal?.aborted || isStopped() || e?.name === "AbortError") {
            log("system", t("aStopped"));
            return finalAnswer;
          }
          throw e;
        }
      }
      tab = await recoverTaskTab();
      obs = await observe(tab, cfg, {
        visionState,
        forceImage: forceNextImage || needsNavigationWait,
        preferTextOnly: !forceNextImage && !needsNavigationWait,
        perf
      });
      messages.push(obsMessage(`当前页面：\n${obs.text}`, obs.image));
    }

    log("system", t("aMaxSteps", MAX_STEPS));
    return finalAnswer;
  } finally {
    chrome.tabs.onCreated.removeListener(onTabCreated);
    await setGlow(tabId, false);
    await cdp.detachAll();
    const report = {
      ...perf,
      totalMs: performance.now() - perf.startedAt,
      finishedAt: Date.now()
    };
    delete report.startedAt;
    chrome.storage.session.set({ lastPerformance: report }).catch(() => {});
    console.info("[NL Browser Agent performance]", report);
  }
}

function describeAction(name, args) {
  if (name === "navigate") return t("aNav", args.url);
  if (name === "list_tabs") return t("aListTabs");
  if (name === "switch_tab") return t("aSwitchTab", args.tab_id);
  if (name === "click") return t("aClick", args.index);
  if (name === "fill_form") return t("aFillForm", Array.isArray(args.fields) ? args.fields.length : 0, args.submit_index != null);
  if (name === "click_at") {
    if (args.clicks === 3) return t("aTriClickAt", args.x, args.y);
    if (args.clicks === 2) return t("aDblClickAt", args.x, args.y);
    return t("aClickAt", args.x, args.y, !!args.hold_shift);
  }
  if (name === "find_replace_all") return t("aFR", args.find, args.replace ?? "", !!args.use_regex);
  if (name === "select_text") return t("aSel", args.text);
  if (name === "type_text") {
    return args.index === undefined ? t("aTypeCursor", args.text) : t("aType", args.index, args.text, !!args.enter);
  }
  if (name === "press_key") {
    const mods = [args.ctrl && "Ctrl", args.shift && "Shift", args.alt && "Alt", args.meta && "Cmd"].filter(Boolean);
    return t("aPress", [...mods, args.key].join("+"));
  }
  if (name === "scroll") return args.direction === "up" ? t("aScrollUp") : t("aScrollDown");
  return name;
}
