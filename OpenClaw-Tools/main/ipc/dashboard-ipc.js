function registerDashboardIpcHandlers(deps = {}) {
    const {
        ipcMain,
        resolveDashboardActionRequest,
        invalidateDashboardProbeCaches,
        stopDashboardLogFollowByKey,
        resolveOfficialDashboardStartRequestStable,
        resolveNpmDashboardPreflight,
        runOfficialAutoStartActionWithVerification,
        startDetachedDashboardGatewayLaunch,
        runCapturedProcess,
        waitForGatewayOfflineAfterStop,
        killWindowsProcessIdsSync,
        formatPidList,
        waitForGatewayOnlineAfterLaunch,
        buildHiddenWindowsLauncherSpawnRequest,
        spawnDetachedBackgroundProcess,
        startManagedProcess,
        runManagedShellCommand,
        runManagedCommand
    } = deps;

    ipcMain.on('execute-dashboard-action', async (event, payload = {}) => {
        const id = String(payload.id || `dashboard-${Date.now()}`).trim();
        const action = String(payload.action || '').trim();
        const mode = payload.mode === 'npm' ? 'npm' : 'official';
        const isLifecycleAction = ['start', 'stop', 'restart'].includes(action);
        let request = resolveDashboardActionRequest(action, mode);
        let preflightPreamble = '';

        if (isLifecycleAction || action === 'enable-autostart' || action === 'disable-autostart') {
            invalidateDashboardProbeCaches(mode);
        }

        if (isLifecycleAction) {
            stopDashboardLogFollowByKey(Number(event.sender?.id || 0), { notify: false });
        }

        if (mode === 'official' && action === 'start' && request && !request.error) {
            try {
                request = await resolveOfficialDashboardStartRequestStable();
            } catch (error) {
                request = {
                    mode: 'official',
                    action: 'start',
                    error: `原版启动预检查失败：${error.message}`
                };
            }
        }

        if (mode === 'npm' && ['start', 'stop', 'restart'].includes(action) && request && !request.error) {
            try {
                const preflight = await resolveNpmDashboardPreflight(action);
                if (preflight?.requestOverride) {
                    request = preflight.requestOverride;
                }
                preflightPreamble = String(preflight?.preamble || '');
            } catch (error) {
                preflightPreamble = `[WARN] npm 管理预检查失败，继续按原流程执行：${error.message}\n`;
            }
        }

        if (!request) {
            event.sender.send('command-started', { id, command: action || 'dashboard-action' });
            event.sender.send('command-stream', { id, type: 'error', text: `不支持的首页动作：${action}\n` });
            event.sender.send('command-finished', { id, code: -1 });
            return;
        }

        if (request.error) {
            event.sender.send('command-started', { id, command: request.previewCommand });
            event.sender.send('command-stream', {
                id,
                type: 'error',
                text: `${request.error}\n`
            });
            event.sender.send('command-finished', { id, code: -1 });
            return;
        }

        if (request.alreadyRunning) {
            event.sender.send('command-started', {
                id,
                command: request.previewCommand,
                meta: {
                    source: 'dashboard',
                    action,
                    mode
                }
            });
            if (preflightPreamble) {
                event.sender.send('command-stream', {
                    id,
                    type: 'sys',
                    text: preflightPreamble
                });
            }
            for (const message of request.infoMessages || []) {
                event.sender.send('command-stream', {
                    id,
                    type: 'sys',
                    text: message
                });
            }
            event.sender.send('command-finished', { id, code: request.finishCode ?? 0 });
            return;
        }

        if (request.spawnRequest) {
            event.sender.send('command-started', {
                id,
                command: request.previewCommand,
                meta: {
                    source: 'dashboard',
                    action,
                    mode
                }
            });
            if (preflightPreamble) {
                event.sender.send('command-stream', {
                    id,
                    type: 'sys',
                    text: preflightPreamble
                });
            }
            if (request.preamble) {
                event.sender.send('command-stream', {
                    id,
                    type: 'sys',
                    text: request.preamble
                });
            }
            if (mode === 'official' && (action === 'enable-autostart' || action === 'disable-autostart')) {
                await runOfficialAutoStartActionWithVerification(event.sender, id, action, request);
                return;
            }
            if (mode === 'official' && action === 'start' && !request.fallbackSpawnRequest) {
                await startDetachedDashboardGatewayLaunch(event.sender, id, request);
                return;
            }
            if (mode === 'official' && action === 'stop') {
                const result = await runCapturedProcess(request.spawnRequest, {
                    timeoutMs: request.timeoutMs,
                    encoding: request.encoding || 'utf8'
                });

                if (result.stdout) {
                    event.sender.send('command-stream', {
                        id,
                        type: 'stdout',
                        text: result.stdout
                    });
                }
                if (result.stderr) {
                    event.sender.send('command-stream', {
                        id,
                        type: 'stderr',
                        text: result.stderr
                    });
                }

                if (!result.ok) {
                    if (result.error?.message) {
                        event.sender.send('command-stream', {
                            id,
                            type: 'error',
                            text: `[EXEC ERROR] ${result.error.message}\n`
                        });
                    }
                    event.sender.send('command-finished', { id, code: result.code ?? -1 });
                    return;
                }

                let offline = await waitForGatewayOfflineAfterStop({ timeoutMs: 6000, intervalMs: 500 });
                if (!offline.ok && process.platform === 'win32') {
                    const lingeringPid = Number.parseInt(String(offline.status?.pid || ''), 10);
                    if (lingeringPid > 0) {
                        const cleanup = killWindowsProcessIdsSync([lingeringPid]);
                        if (cleanup.killed.length) {
                            event.sender.send('command-stream', {
                                id,
                                type: 'sys',
                                text: `[INFO] 官方停止命令后仍检测到残留 Gateway 进程，已补充清理 PID ${formatPidList(cleanup.killed)}。\n`
                            });
                        }
                        if (cleanup.failed.length) {
                            event.sender.send('command-stream', {
                                id,
                                type: 'error',
                                text: `[EXEC ERROR] 残留 Gateway 进程清理失败：${cleanup.failed.map((item) => `${item.pid}: ${item.error}`).join('; ')}\n`
                            });
                        }
                        offline = await waitForGatewayOfflineAfterStop({ timeoutMs: 4000, intervalMs: 400 });
                    }
                }

                if (!offline.ok) {
                    event.sender.send('command-stream', {
                        id,
                        type: 'error',
                        text: `[首页动作] ${request.previewCommand} 已退出，但网关仍在线。\n`
                    });
                    event.sender.send('command-finished', { id, code: 1 });
                    return;
                }

                event.sender.send('command-finished', { id, code: 0 });
                return;
            }
            if (mode === 'official' && action === 'start' && request.fallbackSpawnRequest) {
                const result = await runCapturedProcess(request.spawnRequest, {
                    timeoutMs: request.timeoutMs,
                    encoding: request.encoding || 'utf8'
                });

                if (result.stdout) {
                    event.sender.send('command-stream', {
                        id,
                        type: 'stdout',
                        text: result.stdout
                    });
                }
                if (result.stderr) {
                    event.sender.send('command-stream', {
                        id,
                        type: 'stderr',
                        text: result.stderr
                    });
                }

                if (!result.ok) {
                    if (result.error?.message) {
                        event.sender.send('command-stream', {
                            id,
                            type: 'error',
                            text: `[EXEC ERROR] ${result.error.message}\n`
                        });
                    }
                    event.sender.send('command-finished', { id, code: result.code ?? -1 });
                    return;
                }

                const online = await waitForGatewayOnlineAfterLaunch({ timeoutMs: 15000, intervalMs: 500 });
                if (online.ok) {
                    event.sender.send('command-finished', { id, code: 0 });
                    return;
                }

                if (request.fallbackSpawnRequest) {
                    event.sender.send('command-stream', {
                        id,
                        type: 'sys',
                        text: `[WARN] ${request.previewCommand} 已退出，但 Gateway 仍未在线，正在回退执行 ${request.fallbackPreviewCommand || 'openclaw gateway run'}。\n`
                    });
                    const fallbackSpawnRequest = process.platform === 'win32'
                        ? buildHiddenWindowsLauncherSpawnRequest(request.fallbackSpawnRequest)
                        : request.fallbackSpawnRequest;
                    const detached = spawnDetachedBackgroundProcess(fallbackSpawnRequest);
                    if (!detached.ok) {
                        event.sender.send('command-stream', {
                            id,
                            type: 'error',
                            text: `[EXEC ERROR] ${detached.error?.message || 'fallback spawn failed'}\n`
                        });
                        event.sender.send('command-finished', { id, code: -1 });
                        return;
                    }
                    const fallbackOnline = await waitForGatewayOnlineAfterLaunch({ timeoutMs: 45000, intervalMs: 500 });
                    if (fallbackOnline.ok) {
                        event.sender.send('command-stream', {
                            id,
                            type: 'sys',
                            text: `[INFO] 已回退执行 ${request.fallbackPreviewCommand || 'openclaw gateway run'}，Gateway 已上线。\n`
                        });
                        event.sender.send('command-finished', { id, code: 0 });
                        return;
                    }
                    event.sender.send('command-stream', {
                        id,
                        type: 'error',
                        text: `[首页动作] ${request.previewCommand} 已退出，回退执行 ${request.fallbackPreviewCommand || 'openclaw gateway run'} 后网关仍未在线。\n`
                    });
                    event.sender.send('command-finished', { id, code: 1 });
                    return;
                }

                event.sender.send('command-stream', {
                    id,
                    type: 'error',
                    text: `[首页动作] ${request.previewCommand} 已退出，但网关仍未在线。\n`
                });
                event.sender.send('command-finished', { id, code: 1 });
                return;
            }
            startManagedProcess(event.sender, id, request.spawnRequest, {
                timeoutMs: request.timeoutMs,
                encoding: request.encoding || 'utf8',
                commandLine: request.previewCommand
            });
            return;
        }

        event.sender.send('command-started', {
            id,
            command: request.previewCommand,
            meta: {
                source: 'dashboard',
                action,
                mode
            }
        });

        if (request.commandLine) {
            if (preflightPreamble) {
                event.sender.send('command-stream', {
                    id,
                    type: 'sys',
                    text: preflightPreamble
                });
            }
            if (request.preamble) {
                event.sender.send('command-stream', {
                    id,
                    type: 'sys',
                    text: request.preamble
                });
            }
            runManagedShellCommand(event.sender, id, request.commandLine, {
                timeoutMs: request.timeoutMs,
                encoding: request.encoding,
                cwd: request.cwd
            });
            return;
        }

        if (preflightPreamble) {
            event.sender.send('command-stream', {
                id,
                type: 'sys',
                text: preflightPreamble
            });
        }
        if (request.preamble) {
            event.sender.send('command-stream', {
                id,
                type: 'sys',
                text: request.preamble
            });
        }
        runManagedCommand(event.sender, id, request.command, {
            timeoutMs: request.timeoutMs,
            encoding: request.encoding,
            cwd: request.cwd
        });
    });
}

module.exports = {
    registerDashboardIpcHandlers
};
