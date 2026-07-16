// 后台 service worker：让点击工具栏图标时打开侧边栏，并处理面板发来的控制消息
function enableSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);
enableSidePanel();

// 侧边栏页面自己调 window.close() 无效，必须由后台 disable 一下才会收起。
// 之后立刻重新 enable，保证工具栏图标下次还能打开侧边栏。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "closeSidePanel") {
    chrome.sidePanel
      .setOptions({ enabled: false })
      .then(() => new Promise((r) => setTimeout(r, 250)))
      .then(() => chrome.sidePanel.setOptions({ enabled: true }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // 异步 sendResponse
  }
});
