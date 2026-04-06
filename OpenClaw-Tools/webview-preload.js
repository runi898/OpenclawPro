const { ipcRenderer } = require('electron');

document.addEventListener('keydown', (e) => {
    // 监听子页面内的斜杠按键
    if (e.key === '/') {
        // 如果是在输入框里按下
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) {
            // 通过 sendToHost 发送消息给父页面的 <webview> 标签的 ipc-message 事件
            ipcRenderer.sendToHost('open-spotlight');
        }
    }
});

// 接收来自主窗体（外壳）直接发过来的强制聊天指令
ipcRenderer.on('inject-chat-command', (event, commandStr) => {
    // 寻找常见的聊天输入框 (适配大多数主流 AI Web UI)
    const chatInput = document.querySelector('textarea, input[type="text"]');
    if (chatInput) {
        // 聚焦并赋值
        chatInput.focus();
        // 如果是 React/Vue 等框架，直接操作 value 可能不触发状态变更
        // 我们利用原生原生描述符强制设置值
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        
        if (chatInput.tagName === 'TEXTAREA') {
            nativeTextAreaValueSetter.call(chatInput, commandStr);
        } else {
            nativeInputValueSetter.call(chatInput, commandStr);
        }
        
        // 派发 input 事件让框架感知
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        chatInput.dispatchEvent(new Event('change', { bubbles: true }));
        
        // 尝试寻找发送按钮并点击
        setTimeout(() => {
            // 通常发送按钮在输入框附近，带有 svg 发送图标或者 type="submit"
            const sendBtn = chatInput.closest('form')?.querySelector('button[type="submit"]') || 
                            document.querySelector('button[aria-label*="send" i], button[title*="send" i], button svg').closest('button');
            if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
            } else {
                // 退网手段：模拟按下回车键
                chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }
        }, 100);
    }
});
