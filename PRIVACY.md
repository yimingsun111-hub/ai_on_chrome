# Privacy Policy · 隐私权政策

**NL Browser Agent (Natural Language Browser Agent)**

Last updated: 2026-07-17 · 最后更新：2026-07-17

---

## English

### What this extension does

NL Browser Agent lets you automate your browser with natural-language commands. To do this, when **you** run a task, the extension reads the content of the page being operated (interactive element structure, page text, and — if Vision is enabled — a screenshot) and sends it to the AI model API endpoint **that you yourself configured** (e.g. DeepSeek, OpenAI, or any OpenAI-compatible endpoint), so the model can decide the next action. For a multi-tab task, the model may also receive the titles and URLs of tabs in the current window and the content of a tab it selects for the task.

### Data we collect

**None.** The developer operates no server. No analytics, no telemetry, no tracking. Nothing is ever sent to the developer.

### Data stored on your device

- Your API key, provider settings, theme and language preferences — stored locally via `chrome.storage.local`, never uploaded anywhere by the extension.
- Session chat history — stored via `chrome.storage.session` and automatically erased when the browser closes.
- Local task performance timing (durations and counts only, never page content) — stored via `chrome.storage.session` for the latest task and erased when the browser closes.

### Data sent to third parties

Page content (element structure, text, optional screenshots), current-window tab titles/URLs when needed for a multi-tab task, and your typed instructions/attachments are sent **only** to the model API endpoint you configured, **only** while a task you started is running. That transmission is governed by the privacy policy of the provider you chose. The extension never sends data to any endpoint other than the one you configured.

### Data we do NOT do

- We do not sell or transfer user data to third parties.
- We do not use or transfer user data for purposes unrelated to the extension's single purpose.
- We do not use or transfer user data to determine creditworthiness or for lending purposes.
- We do not continuously collect browsing history or monitor browsing. Pages and tab information are accessed only while a task you explicitly started is running, including a background tab only when that task switches to it.

### Contact

Questions or concerns: open an issue at
https://github.com/yimingsun111-hub/Natural_Language_Browser_Agent/issues

---

## 中文

### 本扩展做什么

NL Browser Agent 让你用自然语言指令自动化操作浏览器。为此，当**你**主动运行任务时，扩展会读取正在操作的页面内容（可交互元素结构、页面文字，若开启视觉功能则包含页面截图），并发送给**你自己配置的** AI 模型接口（如 DeepSeek、OpenAI 或任意 OpenAI 兼容接口），由模型决定下一步操作。执行多标签页任务时，模型还可能收到当前窗口中标签页的标题和网址，以及它为该任务选择的标签页内容。

### 我们收集哪些数据

**不收集。** 开发者不运营任何服务器，没有统计、没有遥测、没有跟踪，任何数据都不会发送给开发者。

### 存储在你设备上的数据

- API Key、服务商配置、主题与语言偏好——通过 `chrome.storage.local` 仅存本机，扩展不会将其上传到任何地方。
- 会话级聊天记录——存于 `chrome.storage.session`，浏览器关闭后自动清除。
- 最近一次任务的本地性能计时（仅耗时与次数，不含页面内容）——存于 `chrome.storage.session`，浏览器关闭后自动清除。

### 发送给第三方的数据

页面内容（元素结构、文字、可选的截图）、多标签页任务所需的当前窗口标签页标题/网址，以及你输入的指令/附件，**仅**在你主动运行任务期间、**仅**发送给你自己配置的模型接口。该传输受你所选服务商的隐私政策约束。除你配置的接口外，扩展不向任何其他端点发送数据。

### 我们承诺不做的事

- 不向第三方出售或传输用户数据
- 不将用户数据用于与本扩展单一用途无关的目的
- 不将用户数据用于信用评估或放贷目的
- 不持续收集浏览历史或监控浏览行为；页面和标签页信息只会在你明确启动的任务期间访问，后台标签页也只有在任务切换到它时才会读取

### 联系方式

如有疑问，请在 GitHub 提 issue：
https://github.com/yimingsun111-hub/Natural_Language_Browser_Agent/issues
