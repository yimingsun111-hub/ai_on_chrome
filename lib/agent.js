import { getActiveConfig, chatCompletion } from "./providers.js";
import { buildSnapshot, performAction, performKey, locateFindReplace, fillFindReplace, clickMarked, readDialogText, locateDocsCanvas, showGlow, hideGlow } from "./page.js";
import * as cdp from "./cdp.js";
import { loadLang, setCurrent, t, PROMPT_LANG } from "./i18n.js";
import { loadTheme, hexToRgba } from "./theme.js";

const MAX_STEPS = 20;

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
      description: "按一个键，可带修饰键。用于回车/删除(Delete/Backspace)/方向键，或快捷键。本机是 macOS，全选/复制等用 meta。",
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
      name: "done",
      description: "任务确实完成(需在截图中确认结果)或无法继续时调用，给出最终结果",
      parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
    }
  }
];

const SYSTEM_PROMPT = `你是一个浏览器操作助手。你能看到当前网页上被编号的可交互元素，还会收到一张网页截图。你通过调用工具一步步完成用户的自然语言任务。

规则：
- 无论页面或本提示是什么语言，始终用「{{REPLY_LANG}}」回复用户。
- 截图中若出现「NL Browser Agent」悬浮窗，那是你自己的控制界面：忽略它，绝不要点击或操作它。
- 每次只做一个动作，做完后你会收到新的页面状态，再决定下一步。
- 若当前是浏览器内部页(如新标签页)或页面不对，直接用 navigate 打开目标网址。Google Docs=https://docs.google.com ，Google=https://www.google.com 。
- 需要搜索时，通常先在搜索框 type_text 并把 enter 设为 true。
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
  return false;
}

// 遇到 429 限流按建议时间等待后自动重试
async function callWithRetry(cfg, messages, tools, log, isStopped) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chatCompletion(cfg, messages, tools);
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
    lines.push(`[${el.id}] <${el.tag}${type}> ${el.label}`);
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
    return await downscale(raw, cssWidth || 1100);
  } catch (_) {
    return null;
  }
}

async function downscale(dataUrl, maxW) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    if (scale >= 1) return dataUrl;
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(out);
    });
  } catch (_) {
    return dataUrl;
  }
}

// 发给模型前裁剪历史：只保留最新一条页面观察(含截图)，旧的压成一句话，避免 token 指数增长
function pruneForSend(messages) {
  const n = messages.length;
  return messages.map((m, i) => {
    const isObs =
      (Array.isArray(m.content) && m.content.some((c) => c.type === "image_url")) ||
      (typeof m.content === "string" && m.content.startsWith("当前页面："));
    if (isObs && i !== n - 1) return { role: m.role, content: "（较早的页面状态已省略以节省额度）" };
    return m;
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
async function observe(tab, cfg) {
  if (!tab) return { text: "（当前没有可用标签页，可用 navigate 打开一个网址开始。）", image: null, snapshot: null };
  if (isRestricted(tab.url)) {
    return { text: `（当前是浏览器内部页面「${tab.url}」，无法读取内容。若需访问网页，请先用 navigate 打开对应网址。）`, image: null, snapshot: null };
  }
  try {
    await setGlow(tab.id, true); // 导航后页面刷新会丢光效，每次观察时补上（幂等）
    const snapshot = await runInPage(tab.id, buildSnapshot);
    let image = null;
    if (cfg.vision) image = await capture(tab, cfg, snapshot.viewport.width);
    return { text: formatObservation(snapshot), image, snapshot };
  } catch (e) {
    return { text: `（无法读取此页面：${e.message}。可尝试用 navigate 打开别的网址。）`, image: null, snapshot: null };
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
  await sleep(150);
  if (text === "") {
    await cdp.pressKey(tabId, "Backspace");
  } else {
    await cdp.insertText(tabId, text);
  }
  await sleep(150);
}

async function runFindReplace(tab, args, cfg) {
  const useCdp = cfg.useDebugger && cdp.isAttached(tab.id);
  if (!useCdp) return { ok: false, error: "find_replace_all 需要开启「真实按键(debugger)」（新版 Docs 对话框只认真实输入）。" };

  // 1. 对话框没开：先真实点击正文拿焦点（实测：焦点不在正文时快捷键无效），再按 Cmd+Shift+H
  let info = await runInPage(tab.id, locateFindReplace);
  if (!info.open) {
    const canvas = await runInPage(tab.id, locateDocsCanvas);
    if (canvas.ok) { await cdp.clickAt(tab.id, canvas.x, canvas.y); await sleep(300); }
    await cdp.pressKey(tab.id, "h", cdp.modMask({ meta: true, shift: true }));
    await sleep(1200);
    info = await runInPage(tab.id, locateFindReplace);
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

  // 3. 勾/取消"使用正则"（状态由 DOM 读出，只在不一致时点一次）
  const wantRegex = !!args.use_regex;
  if (info.hasRegex && info.regexChecked !== wantRegex) {
    await clickControl(tab.id, useCdp, info, "regex");
    await sleep(250);
  } else if (!info.hasRegex && wantRegex) {
    return { ok: false, error: "对话框里找不到「使用正则表达式」勾选框，无法用正则。" };
  }

  // 4. 点"全部替换"，读结果
  await sleep(400);
  info = await runInPage(tab.id, locateFindReplace); // 刷新坐标/状态
  if (info.allDisabled) {
    const hint = await runInPage(tab.id, readDialogText);
    await cdp.pressKey(tab.id, "Escape");
    return {
      ok: false,
      error: `「全部替换」按钮不可点——查找内容无匹配（对话框状态：${hint.slice(-80)}）。两种可能：①正则没写对，换个写法重试；②文档里本来就没有要改的内容——对照最新截图确认，若目标其实已达成，直接调用 done 说明即可。`
    };
  }
  await clickControl(tab.id, useCdp, info, "replaceall");
  await sleep(900);
  const resultText = await runInPage(tab.id, readDialogText);

  // 5. 关闭对话框（Escape 即可）
  await cdp.pressKey(tab.id, "Escape");
  await sleep(300);

  return { ok: true, result: `已执行全部替换。对话框末尾状态：${resultText}（匹配计数变为 0/0 即代表全部替换成功）` };
}

// 用 Docs 自带查找(Cmd+F)按文字精确选中一处：打开查找→输入→跳到匹配→Esc 后选区留在匹配上
async function runSelectText(tab, args, cfg) {
  const useCdp = cfg.useDebugger && cdp.isAttached(tab.id);
  if (!useCdp) return { ok: false, error: "select_text 需要开启「真实按键(debugger)」。" };
  await cdp.pressKey(tab.id, "f", cdp.modMask({ meta: true }));
  await sleep(500);
  await cdp.insertText(tab.id, args.text);
  await sleep(450);
  await cdp.pressKey(tab.id, "Enter");
  await sleep(300);
  await cdp.pressKey(tab.id, "Escape");
  await sleep(300);
  return { ok: true, note: "已尝试选中该文字。请在新截图中确认选区正确后再删除/替换；若没选中可重试或改用 find_replace_all。" };
}

async function executeAction(tab, name, args, cfg, snap) {
  const el = snap?.elements?.find((e) => e.id === args.index);
  const useCdp = cfg.useDebugger && cdp.isAttached(tab.id);

  if (name === "find_replace_all") return await runFindReplace(tab, args, cfg);
  if (name === "select_text") return await runSelectText(tab, args, cfg);

  if (name === "navigate") {
    let url = args.url || "";
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    await chrome.tabs.update(tab.id, { url });
    await sleep(2500);
    return { ok: true, url };
  }

  if (name === "click") {
    if (useCdp && el) return await tryCdp(() => cdp.clickAt(tab.id, el.cx, el.cy));
    if (!el) return { ok: false, error: "找不到该编号的元素" };
    return await actSynthetic(tab.id, { type: "click", index: args.index });
  }

  if (name === "click_at") {
    if (!useCdp) return { ok: false, error: "按坐标点击需要开启「真实按键(debugger)」" };
    const clicks = Math.min(3, Math.max(1, args.clicks || 1));
    return await tryCdp(() => cdp.clickAt(tab.id, Math.round(args.x), Math.round(args.y), args.hold_shift ? 8 : 0, clicks));
  }

  if (name === "type_text") {
    if (useCdp) {
      return await tryCdp(async () => {
        if (el) { await cdp.clickAt(tab.id, el.cx, el.cy); await sleep(150); }
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
 * @returns {Promise<string>} 最终回复
 */
export async function runTask(task, log, isStopped, history = []) {
  const cfg = await getActiveConfig();
  if (!cfg.apiKey) { log("error", t("aNoKey")); return ""; }

  const startTab = await getActiveTab();
  if (!startTab) { log("error", t("aNoTab")); return ""; }
  const tabId = startTab.id;

  await ensureDebugger(startTab, cfg, log);
  currentGlowColor = hexToRgba((await loadTheme()).glow, 0.6);
  const replyLang = (await loadLang()) || "zh-CN";
  setCurrent(replyLang);

  let finalAnswer = "";
  try {
    let tab = await chrome.tabs.get(tabId);
    let obs = await observe(tab, cfg);

    const messages = [{ role: "system", content: SYSTEM_PROMPT.replace("{{REPLY_LANG}}", PROMPT_LANG[replyLang] || replyLang) }];
    for (const turn of history.slice(-6)) messages.push({ role: turn.role, content: turn.content });
    messages.push({ role: "user", content: `任务：${task}` });
    messages.push(obsMessage(`当前页面：\n${obs.text}`, obs.image));

    for (let step = 0; step < MAX_STEPS; step++) {
      if (isStopped()) { log("system", t("aStopped")); return finalAnswer; }

      let data;
      try {
        data = await callWithRetry(cfg, pruneForSend(messages), TOOLS, log, isStopped);
      } catch (e) {
        log("error", t("aModelFail", e.message));
        return finalAnswer;
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
        try {
          result = await executeAction(tab, name, args, cfg, obs.snapshot);
        } catch (e) {
          result = { ok: false, error: e.message };
        }
        // 把关键结果显示到界面，方便用户了解进展/排错
        if (result?.ok === false) log("system", t("aResFail", result.error));
        else if (result?.result) log("system", t("aResOk", result.result));
        messages.push({ role: "tool", tool_call_id: tc.id, content: `执行结果：${JSON.stringify(result)}` });
      }
      if (finished) return finalAnswer;

      await sleep(900);
      tab = await chrome.tabs.get(tabId);
      obs = await observe(tab, cfg);
      messages.push(obsMessage(`当前页面：\n${obs.text}`, obs.image));
    }

    log("system", t("aMaxSteps", MAX_STEPS));
    return finalAnswer;
  } finally {
    await setGlow(tabId, false);
    await cdp.detachAll();
  }
}

function describeAction(name, args) {
  if (name === "navigate") return t("aNav", args.url);
  if (name === "click") return t("aClick", args.index);
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
