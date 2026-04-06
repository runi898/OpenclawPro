function registerCommandIpcHandlers(deps = {}) {
    const {
        ipcMain,
        activeProcesses,
        terminateProcessTree,
        finishActiveProcess,
        runManagedCommand
    } = deps;

    ipcMain.on('kill-command', (event, { id }) => {
        const meta = activeProcesses.get(id);
        if (!meta) {
            event.sender.send('command-finished', { id, code: 'KILLED' });
            return;
        }

        if (meta.forcedCode) return;

        meta.forcedCode = 'KILLED';
        event.sender.send('command-stream', {
            id,
            type: 'sys',
            text: '\n[system] 命令已被用户手动终止。\n'
        });
        terminateProcessTree(meta.child);

        setTimeout(() => {
            if (activeProcesses.has(id) && meta.forcedCode === 'KILLED') {
                finishActiveProcess(id, event.sender, 'KILLED');
            }
        }, 2000);
    });

    ipcMain.on('command-input', (event, payload = {}) => {
        const id = String(payload.id || '').trim();
        const meta = activeProcesses.get(id);
        if (!meta || !meta.child || !meta.child.stdin || meta.child.stdin.destroyed || !meta.child.stdin.writable) {
            event.sender.send('command-stream', {
                id,
                type: 'error',
                text: '[INPUT ERROR] 当前会话不接受输入或已结束。\n'
            });
            return;
        }

        const input = String(payload.input ?? '');
        const suffix = payload.appendNewline ? '\r\n' : '';
        try {
            meta.child.stdin.write(`${input}${suffix}`);
        } catch (error) {
            event.sender.send('command-stream', {
                id,
                type: 'error',
                text: `[INPUT ERROR] ${error.message}\n`
            });
        }
    });

    ipcMain.on('execute-command', (event, { id, command, timeout: customTimeout, interactive = false, commandOptions = {} }) => {
        event.sender.send('command-started', { id, command, interactive: Boolean(interactive) });
        runManagedCommand(event.sender, id, command, {
            timeoutMs: customTimeout,
            interactive: Boolean(interactive),
            ...(commandOptions && typeof commandOptions === 'object' ? commandOptions : {})
        });
    });
}

module.exports = {
    registerCommandIpcHandlers
};
