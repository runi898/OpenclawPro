function registerModelIpcHandlers(deps = {}) {
    const {
        ipcMain,
        readOpenClawConfigSync,
        writeOpenClawConfigSync,
        buildRuntimeModelCatalog,
        resolveProviderContext,
        listRemoteModelsForContext,
        testProviderModelWithContext,
        pruneInvalidModelsFromConfig,
        pruneInvalidModelsFromAllAgents
    } = deps;

    ipcMain.handle('get-runtime-model-catalog', (_, payload = {}) => {
        try {
            const config = readOpenClawConfigSync();
            const agentName = payload?.agentName || 'main';
            return buildRuntimeModelCatalog(config, agentName);
        } catch (error) {
            console.error('[Models] Catalog failed:', error.message);
            return { providers: [] };
        }
    });

    ipcMain.handle('list-remote-models', async (_, payload = {}) => {
        try {
            const config = readOpenClawConfigSync();
            const context = resolveProviderContext(config, payload);
            const result = await listRemoteModelsForContext(context);
            return {
                ok: true,
                providerKey: context.providerKey,
                models: Array.isArray(result?.models) ? result.models : [],
                source: result?.source || 'provider-api',
                note: result?.note || ''
            };
        } catch (error) {
            console.error('[Models] Remote list failed:', error.message);
            return {
                ok: false,
                error: error.message,
                models: []
            };
        }
    });

    ipcMain.handle('test-provider-model', async (_, payload = {}) => {
        try {
            const config = readOpenClawConfigSync();
            const context = resolveProviderContext(config, payload);
            const modelId = String(payload?.modelId || '').trim();
            if (!modelId) throw new Error('Missing model id');
            return await testProviderModelWithContext(context, modelId, Number(payload?.timeoutMs) || 15000);
        } catch (error) {
            console.error('[Models] Test failed:', error.message);
            return {
                ok: false,
                error: error.message,
                label: error.message
            };
        }
    });

    ipcMain.handle('remove-invalid-models', (_, payload = {}) => {
        try {
            const requestedModels = Array.isArray(payload?.models) ? payload.models : [];
            const config = readOpenClawConfigSync();
            const next = pruneInvalidModelsFromConfig(config, requestedModels);
            if (!next.removed.length) {
                return {
                    ok: true,
                    removed: [],
                    count: 0
                };
            }

            pruneInvalidModelsFromAllAgents(next.config, next.removed);
            const result = writeOpenClawConfigSync(next.config);
            return {
                ...result,
                removed: next.removed,
                count: next.removed.length
            };
        } catch (error) {
            console.error('[Models] Remove invalid failed:', error.message);
            return {
                ok: false,
                error: error.message,
                removed: [],
                count: 0
            };
        }
    });
}

module.exports = {
    registerModelIpcHandlers
};
