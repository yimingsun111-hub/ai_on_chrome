// 内置的模型服务商模板（都是 OpenAI 兼容接口）。用户可自定义 Base URL / Model / Key。
// vision: 该模型是否支持看图（视觉）。开启视觉功能需要选带 vision 的模型。
export const PRESETS = [
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", vision: false },
  { id: "qwen-vl", name: "通义千问-VL（视觉）", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max", vision: true },
  { id: "kimi-vl", name: "Kimi 视觉 (Moonshot)", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k-vision-preview", vision: true },
  { id: "gpt4o", name: "OpenAI GPT-4o（视觉）", baseURL: "https://api.openai.com/v1", model: "gpt-4o", vision: true },
  { id: "kimi", name: "Kimi (Moonshot)", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", vision: false },
  { id: "qwen", name: "通义千问 (Qwen)", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", vision: false },
  { id: "custom", name: "自定义 (OpenAI 兼容)", baseURL: "", model: "", vision: false }
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

// 底层请求
async function post(cfg, body) {
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

// 调用 OpenAI 兼容的 chat/completions（带 tool calling）
export async function chatCompletion(cfg, messages, tools) {
  return post(cfg, { model: cfg.model, messages, tools, tool_choice: "auto", temperature: 0.2 });
}

// 测试连接：发一条最小请求，返回模型回复或抛出详细错误
export async function testConnection(cfg) {
  if (!cfg.baseURL) throw new Error("Base URL 为空");
  if (!cfg.apiKey) throw new Error("API Key 为空");
  if (!cfg.model) throw new Error("模型名为空");
  const data = await post(cfg, { model: cfg.model, messages: [{ role: "user", content: "只回复：ok" }], max_tokens: 10 });
  return data.choices?.[0]?.message?.content ?? "(收到空回复)";
}
