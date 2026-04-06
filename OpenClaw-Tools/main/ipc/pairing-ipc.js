function registerPairingIpcHandlers(deps = {}) {
    const {
        ipcMain,
        runOpenClawCliCaptured,
        parseCliJsonOutput,
        cloneJsonValue
    } = deps;

    ipcMain.handle('list-pairing-requests', async (_, payload = {}) => {
        try {
            const requestedChannel = String(payload?.channel || '').trim().toLowerCase();
            const channelList = requestedChannel ? [requestedChannel] : ['telegram', 'feishu'];
            const requests = [];
            const errors = [];
            let succeeded = false;

            for (const channel of channelList) {
                const args = ['pairing', 'list', channel];
                if (payload?.accountId) {
                    args.push('--account', String(payload.accountId).trim());
                }
                args.push('--json');

                const result = await runOpenClawCliCaptured(args, {
                    timeoutMs: Number(payload?.timeoutMs) || 30000
                });
                if (!result.ok) {
                    errors.push(String(result.stderr || result.stdout || result.error?.message || `读取 ${channel} 配对请求失败`).trim());
                    continue;
                }
                succeeded = true;

                const parsed = parseCliJsonOutput(result.stdout);
                const channelRequests = Array.isArray(parsed)
                    ? parsed
                    : Array.isArray(parsed?.requests)
                        ? parsed.requests
                        : Array.isArray(parsed?.items)
                            ? parsed.items
                            : [];

                for (const request of channelRequests) {
                    requests.push({
                        ...cloneJsonValue(request),
                        channel: String(request?.channel || channel).trim() || channel
                    });
                }
            }

            if (!succeeded) {
                throw new Error(errors[0] || '读取配对请求失败');
            }

            return {
                ok: true,
                requests
            };
        } catch (error) {
            console.error('[Pairing] List failed:', error.message);
            return {
                ok: false,
                error: error.message,
                requests: []
            };
        }
    });

    ipcMain.handle('approve-pairing-request', async (_, payload = {}) => {
        try {
            const code = String(payload?.code || '').trim();
            if (!code) throw new Error('缺少配对码');

            const args = ['pairing', 'approve'];
            const channel = String(payload?.channel || '').trim().toLowerCase();
            if (channel) {
                args.push(channel, code);
            } else {
                args.push(code);
            }
            if (payload?.accountId) {
                args.push('--account', String(payload.accountId).trim());
            }
            if (payload?.notify) {
                args.push('--notify');
            }

            const result = await runOpenClawCliCaptured(args, {
                timeoutMs: Number(payload?.timeoutMs) || 30000
            });
            if (!result.ok) {
                throw new Error(String(result.stderr || result.stdout || result.error?.message || '审批配对请求失败').trim());
            }

            return {
                ok: true,
                stdout: result.stdout
            };
        } catch (error) {
            console.error('[Pairing] Approve failed:', error.message);
            return {
                ok: false,
                error: error.message
            };
        }
    });
}

module.exports = {
    registerPairingIpcHandlers
};
