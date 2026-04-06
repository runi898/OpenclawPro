function registerConfigIpcHandlers(deps = {}) {
    const {
        ipcMain,
        readOpenClawConfigSync,
        sanitizeOpenClawConfig,
        validateOpenClawConfig,
        readConfigHealthStateSync,
        rollbackConfigToLastKnownGoodSync,
        writeOpenClawConfigSync
    } = deps;

    ipcMain.handle('get-openclaw-config', () => {
        try {
            return readOpenClawConfigSync();
        } catch (error) {
            console.error('[Config] Read failed:', error.message);
            return {};
        }
    });

    ipcMain.handle('validate-openclaw-config', (_, payload = {}) => {
        try {
            const config = payload?.config && typeof payload.config === 'object'
                ? sanitizeOpenClawConfig(payload.config).config
                : readOpenClawConfigSync();
            const validation = validateOpenClawConfig(config);
            const health = readConfigHealthStateSync();
            return {
                ok: validation.ok,
                ...validation,
                health
            };
        } catch (error) {
            return {
                ok: false,
                errors: [error.message],
                warnings: [],
                health: readConfigHealthStateSync()
            };
        }
    });

    ipcMain.handle('restore-last-known-good-config', () => {
        try {
            return rollbackConfigToLastKnownGoodSync('manual-restore');
        } catch (error) {
            return {
                ok: false,
                error: error.message
            };
        }
    });

    ipcMain.handle('write-openclaw-config', (_, configJson) => {
        try {
            return writeOpenClawConfigSync(configJson || {});
        } catch (error) {
            console.error('[Config] Write failed:', error.message);
            return { ok: false, error: error.message };
        }
    });
}

module.exports = {
    registerConfigIpcHandlers
};
