// DevTools bootstrap: creates the DeepScope panel.
chrome.devtools.panels.create('DeepScope', 'icons/icon32.png', 'panel.html', (panel) => {
  panel.onShown.addListener(() => { /* panel.ts takes over */ });
});
