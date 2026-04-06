const path = require('path');

function registerPlatformIpcHandlers(deps = {}) {
    const {
        ipcMain,
        appDir,
        openClawHomeDir,
        fs,
        QRCode,
        DESKTOP_PLUGIN_PARAMETER_FILE,
        parsePluginParameterText,
        resolveChatWebviewBootstrap,
        readOpenClawConfigSync,
        resolveGatewayAuthToken,
        startDashboardLogFollow,
        stopDashboardLogFollowByKey,
        getActiveChannelInstallOperation,
        readDashboardCacheEntry,
        dashboardStatusCache,
        DASHBOARD_STATUS_CACHE_TTL_MS,
        getChannelEnvironmentProfile,
        resolveDashboardGatewayStatus,
        getDashboardActionDefinitions,
        bumpDashboardAutoStartEpoch,
        dashboardAutoStartCache,
        dashboardAutoStartInflight,
        resolveAutoStartStatus,
        checkPm2RuntimeInstalled,
        ensurePm2RuntimeInstalled,
        checkPm2ServiceInstalled,
        ensurePm2ServiceInstalled,
        resetCachedPm2ServiceRuntime,
        verifyMessagingPlatformCredentials,
        buildCredentialCheckResult,
        getWeixinPluginStatus,
        normalizeChannelEnvironmentKey,
        buildChannelEnvironmentStatus,
        buildAllChannelEnvironmentStatuses,
        resolveChannelInstallSource,
        listChannelInstallSources,
        installChannelEnvironment
    } = deps;

    ipcMain.handle('get-chat-bootstrap', () => {
        try {
            return resolveChatWebviewBootstrap();
        } catch (error) {
            console.error('[Chat] Bootstrap failed:', error.message);
            return {
                url: 'http://127.0.0.1:18789',
                token: '',
                preloadUrl: `file:///${path.join(appDir, 'webview-preload.js').replace(/\\/g, '/')}`
            };
        }
    });

    ipcMain.handle('get-openclaw-token', async () => {
        try {
            const config = readOpenClawConfigSync();
            return resolveGatewayAuthToken(config);
        } catch (_) {
            return '';
        }
    });

    ipcMain.handle('get-app-path', () => appDir);

    ipcMain.on('dashboard-log-follow-start', (event, payload = {}) => {
        startDashboardLogFollow(event.sender, payload);
    });

    ipcMain.on('dashboard-log-follow-stop', (event) => {
        stopDashboardLogFollowByKey(Number(event.sender?.id || 0), { notify: false });
    });

    ipcMain.handle('get-dashboard-gateway-status', async (_, payload = {}) => {
        const mode = payload?.mode === 'npm' ? 'npm' : 'official';
        const activeInstall = getActiveChannelInstallOperation();
        if (activeInstall) {
            const cacheKey = payload?.fast === true ? `${mode}:fast` : mode;
            const cached = readDashboardCacheEntry(dashboardStatusCache, cacheKey, DASHBOARD_STATUS_CACHE_TTL_MS);
            const installLabel = getChannelEnvironmentProfile(activeInstall.channelKey)?.label || activeInstall.channelKey || '渠道';
            if (cached) {
                return {
                    ...cached,
                    source: 'channel-install-lock',
                    detail: `${String(cached.detail || '').trim() || '后台探测已暂停'}；${installLabel} 安装中，暂不触发额外 CLI 探测。`
                };
            }
            return {
                online: false,
                confident: false,
                statusText: '安装中',
                detail: `${installLabel} 安装中，已暂停后台 CLI 探测。`,
                latency: '',
                pid: null,
                source: 'channel-install-lock'
            };
        }
        return resolveDashboardGatewayStatus(mode, { fast: payload?.fast === true });
    });

    ipcMain.handle('get-dashboard-action-definitions', async (_, payload = {}) => {
        const mode = payload?.mode === 'npm' ? 'npm' : 'official';
        return getDashboardActionDefinitions(mode);
    });

    ipcMain.handle('check-auto-start-status', async (_, payload = {}) => {
        const mode = payload?.mode === 'npm' ? 'npm' : 'official';
        const activeInstall = getActiveChannelInstallOperation();
        if (activeInstall) {
            return {
                mode,
                enabled: false,
                detail: '渠道安装进行中，已暂停自启动深度检查。',
                error: ''
            };
        }
        if (payload?.bypassCache === true) {
            bumpDashboardAutoStartEpoch(mode);
            dashboardAutoStartCache.delete(mode);
            dashboardAutoStartInflight.delete(mode);
        }
        return resolveAutoStartStatus(mode, payload);
    });

    ipcMain.handle('check-pm2-runtime-installed', async () => {
        return checkPm2RuntimeInstalled();
    });

    ipcMain.handle('ensure-pm2-runtime-installed', async () => {
        const result = ensurePm2RuntimeInstalled();
        if (result?.ok && result?.installed) {
            resetCachedPm2ServiceRuntime();
        }
        return result;
    });

    ipcMain.handle('check-pm2-service-installed', async () => {
        return checkPm2ServiceInstalled();
    });

    ipcMain.handle('ensure-pm2-service-installed', async () => {
        const result = ensurePm2ServiceInstalled();
        if (result?.ok && result?.installed) {
            resetCachedPm2ServiceRuntime();
        }
        return result;
    });

    ipcMain.handle('verify-bot-token', async (_, payload = {}) => {
        try {
            return await verifyMessagingPlatformCredentials(payload || {});
        } catch (error) {
            return buildCredentialCheckResult({
                valid: false,
                errors: [error?.message || String(error)]
            });
        }
    });

    ipcMain.handle('verify-channel-credentials', async (_, payload = {}) => {
        try {
            return await verifyMessagingPlatformCredentials(payload || {});
        } catch (error) {
            return buildCredentialCheckResult({
                valid: false,
                errors: [error?.message || String(error)]
            });
        }
    });

    ipcMain.handle('check-weixin-plugin-status', async (_, payload = {}) => {
        try {
            return await getWeixinPluginStatus(payload || {});
        } catch (error) {
            return {
                installed: false,
                installedVersion: '',
                latestVersion: '',
                updateAvailable: false,
                extensionDir: path.join(openClawHomeDir, 'extensions', 'openclaw-weixin'),
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('generate-qr-code-data-url', async (_, payload = {}) => {
        const text = String(payload?.text || '').trim();
        if (!text) {
            return {
                ok: false,
                error: 'QR text is required.'
            };
        }

        const width = Math.min(640, Math.max(160, Number(payload?.width) || 280));
        const margin = Math.min(8, Math.max(0, Number(payload?.margin) || 1));

        try {
            const dataUrl = await QRCode.toDataURL(text, {
                errorCorrectionLevel: 'M',
                type: 'image/png',
                width,
                margin,
                color: {
                    dark: String(payload?.darkColor || '#101418'),
                    light: String(payload?.lightColor || '#ffffffff')
                }
            });
            return {
                ok: true,
                dataUrl
            };
        } catch (error) {
            return {
                ok: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('get-channel-environment-status', (_, payload = {}) => {
        try {
            const requestedChannel = normalizeChannelEnvironmentKey(payload?.channel || payload?.platform || payload?.key || '');
            const config = readOpenClawConfigSync();
            const deepProbe = payload?.deepProbe === true;
            const localOnly = payload?.localOnly === true;

            if (requestedChannel) {
                const channelStatus = buildChannelEnvironmentStatus(requestedChannel, config, { deepProbe, localOnly });
                return {
                    ok: true,
                    channel: channelStatus,
                    channels: {
                        [requestedChannel]: channelStatus
                    }
                };
            }

            const allStatuses = buildAllChannelEnvironmentStatuses(config, { deepProbe, localOnly });
            return {
                ok: true,
                channels: allStatuses
            };
        } catch (error) {
            console.error('[Channel] Environment status failed:', error.message);
            return {
                ok: false,
                error: error.message,
                channel: null,
                channels: {}
            };
        }
    });

    ipcMain.handle('get-channel-install-sources', (_, payload = {}) => {
        try {
            const profile = getChannelEnvironmentProfile(payload?.channel || payload?.platform || payload?.key || '');
            const selected = resolveChannelInstallSource(payload || {}, profile);
            return {
                ok: true,
                channel: profile?.key || normalizeChannelEnvironmentKey(payload?.channel || payload?.platform || payload?.key || ''),
                defaultValue: selected?.value || 'npmmirror',
                options: listChannelInstallSources()
            };
        } catch (error) {
            return {
                ok: false,
                channel: normalizeChannelEnvironmentKey(payload?.channel || payload?.platform || payload?.key || ''),
                defaultValue: 'npmmirror',
                options: listChannelInstallSources(),
                error: error.message
            };
        }
    });

    ipcMain.handle('get-desktop-plugin-parameter-audit', () => {
        try {
            const exists = fs.existsSync(DESKTOP_PLUGIN_PARAMETER_FILE);
            const text = exists ? fs.readFileSync(DESKTOP_PLUGIN_PARAMETER_FILE, 'utf8') : '';
            return {
                ok: true,
                exists,
                filePath: DESKTOP_PLUGIN_PARAMETER_FILE,
                audit: parsePluginParameterText(text)
            };
        } catch (error) {
            return {
                ok: false,
                exists: false,
                filePath: DESKTOP_PLUGIN_PARAMETER_FILE,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('install-channel-environment', async (event, payload = {}) => {
        try {
            return await installChannelEnvironment(payload || {}, { sender: event?.sender || null });
        } catch (error) {
            console.error('[Channel] Install failed:', error.message);
            return {
                ok: false,
                installed: false,
                channel: normalizeChannelEnvironmentKey(payload?.channel || payload?.platform || payload?.key || ''),
                error: error.message
            };
        }
    });
}

module.exports = {
    registerPlatformIpcHandlers
};
