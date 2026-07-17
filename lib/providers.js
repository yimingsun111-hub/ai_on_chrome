// 内置的模型服务商模板（都是 OpenAI 兼容接口）。用户可自定义 Base URL / Model / Key。
// vision: 该模型是否支持看图（视觉）。开启视觉功能需要选带 vision 的模型。
export const PRESETS = [
  { id: "deepseek", name: "DeepSeek", labelKey: "providerDeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", vision: false },
  { id: "qwen-vl", name: "Qwen-VL", labelKey: "providerQwenVL", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max", vision: true },
  { id: "kimi-vl", name: "Kimi Vision (Moonshot)", labelKey: "providerKimiVL", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k-vision-preview", vision: true },
  { id: "gpt4o", name: "OpenAI GPT-4o", labelKey: "providerGPT4o", baseURL: "https://api.openai.com/v1", model: "gpt-4o", vision: true },
  { id: "kimi", name: "Kimi (Moonshot)", labelKey: "providerKimi", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", vision: false },
  { id: "qwen", name: "Qwen", labelKey: "providerQwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", vision: false },
  { id: "custom", name: "Custom (OpenAI-compatible)", labelKey: "providerCustom", baseURL: "", model: "", vision: false }
];

const STORAGE_KEY = "agentConfig";

// 单一配置：{ providerId, name, baseURL, model, apiKey, vision, useDebugger }
export async function loadConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const c = data[STORAGE_KEY];
  if (c && c.apiKey !== undefined) {
    return { vision: false, useDebugger: false, ...c };
  }
  // 默认空配置
  const p = PRESETS[0];
  return { providerId: p.id, name: p.name, baseURL: p.baseURL, model: p.model, apiKey: "", vision: false, useDebugger: false };
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

// 当前配置就是唯一配置
export async function getActiveConfig() {
  return loadConfig();
}

function createRequestController(externalSignal, timeoutMs = 120000) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason || new DOMException("Stopped", "AbortError"));
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  };
}

async function readStreamingResponse(res, onDelta) {
  const reader = res.body?.getReader();
  if (!reader) return res.json();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = null;
  const toolCalls = [];

  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch (_) { return; }
    if (chunk.error) {
      const message = chunk.error.message || JSON.stringify(chunk.error);
      throw new Error(`Streaming API error: ${message}`);
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    for (const part of delta.tool_calls || []) {
      const index = Number.isInteger(part.index) ? part.index : toolCalls.length;
      if (!toolCalls[index]) {
        toolCalls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
      }
      const target = toolCalls[index];
      if (part.id) target.id += part.id;
      if (part.type) target.type = part.type;
      if (part.function?.name) target.function.name += part.function.name;
      if (part.function?.arguments) target.function.arguments += part.function.arguments;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer) consumeLine(buffer);

  const message = { role: "assistant", content: content || null };
  const completeCalls = toolCalls.filter(Boolean).map((call, index) => ({
    ...call,
    id: call.id || `call_stream_${index}`
  }));
  if (completeCalls.length) message.tool_calls = completeCalls;
  return { choices: [{ index: 0, message, finish_reason: finishReason }] };
}

// 底层请求
async function post(cfg, body, { signal: externalSignal, stream = false, onDelta } = {}) {
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const request = createRequestController(externalSignal);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: request.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (stream && contentType.includes("text/event-stream")) return await readStreamingResponse(res, onDelta);
    return await res.json();
  } finally {
    request.cleanup();
  }
}

// 调用 OpenAI 兼容的 chat/completions（带 tool calling）
export async function chatCompletion(cfg, messages, tools, { signal, onDelta } = {}) {
  const base = { model: cfg.model, messages, tools, tool_choice: "auto", temperature: 0.2 };
  try {
    return await post(cfg, { ...base, stream: true }, { signal, stream: true, onDelta });
  } catch (e) {
    if (!signal?.aborted && /stream.{0,40}(unsupported|not supported|invalid)|unsupported.{0,40}stream/i.test(e.message || "")) {
      return post(cfg, base, { signal });
    }
    throw e;
  }
}

// 测试连接：发一条最小请求，返回模型回复或抛出详细错误
export async function testConnection(cfg) {
  if (!cfg.baseURL) throw new Error("Base URL 为空");
  if (!cfg.apiKey) throw new Error("API Key 为空");
  if (!cfg.model) throw new Error("模型名为空");
  const data = await post(cfg, { model: cfg.model, messages: [{ role: "user", content: "只回复：ok" }], max_tokens: 10 });
  return data.choices?.[0]?.message?.content ?? "(收到空回复)";
}
