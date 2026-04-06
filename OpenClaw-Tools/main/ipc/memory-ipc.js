function registerMemoryIpcHandlers(deps = {}) {
    const {
        ipcMain,
        readOpenClawConfigSync,
        listMemoryFilesSync,
        readMemoryFileSync,
        writeMemoryFileSync,
        deleteMemoryFileSync,
        exportMemoryZipSync
    } = deps;

    ipcMain.handle('list-memory-files', (_, payload = {}) => {
        try {
            const config = readOpenClawConfigSync();
            const agentName = payload?.agentName || payload?.agentId || 'main';
            const category = payload?.category || 'memory';
            return {
                ok: true,
                files: listMemoryFilesSync(config, agentName, category)
            };
        } catch (error) {
            console.error('[Memory] List failed:', error.message);
            return {
                ok: false,
                error: error.message,
                files: []
            };
        }
    });

    ipcMain.handle('read-memory-file', (_, payload = {}) => {
        try {
            const config = readOpenClawConfigSync();
            const agentName = payload?.agentName || payload?.agentId || 'main';
            const relativePath = payload?.path || payload?.filePath || '';
            return {
                ok: true,
                content: readMemoryFileSync(config, agentName, relativePath)
            };
        } catch (error) {
            console.error('[Memory] Read failed:', error.message);
            return {
                ok: false,
                error: error.message,
                content: ''
            };
        }
    });

    ipcMain.handle('write-memory-file', (_, payload = {}) => {
        try {
            const config = readOpenClawConfigSync();
            const agentName = payload?.agentName || payload?.agentId || 'main';
            const relativePath = payload?.path || payload?.filePath || '';
            const category = payload?.category || 'memory';
            return writeMemoryFileSync(config, agentName, relativePath, payload?.content || '', category);
        } catch (error) {
            console.error('[Memory] Write failed:', error.message);
            return {
                ok: false,
                error: error.message
            };
        }
    });

    ipcMain.handle('delete-memory-file', (_, payload = {}) => {
        try {
            const config = readOpenClawConfigSync();
            const agentName = payload?.agentName || payload?.agentId || 'main';
            const relativePath = payload?.path || payload?.filePath || '';
            return deleteMemoryFileSync(config, agentName, relativePath);
        } catch (error) {
            console.error('[Memory] Delete failed:', error.message);
            return {
                ok: false,
                error: error.message
            };
        }
    });

    ipcMain.handle('export-memory-zip', (_, payload = {}) => {
        try {
            const config = readOpenClawConfigSync();
            const agentName = payload?.agentName || payload?.agentId || 'main';
            const category = payload?.category || 'memory';
            return {
                ok: true,
                path: exportMemoryZipSync(config, agentName, category)
            };
        } catch (error) {
            console.error('[Memory] Export failed:', error.message);
            return {
                ok: false,
                error: error.message,
                path: ''
            };
        }
    });
}

module.exports = {
    registerMemoryIpcHandlers
};
