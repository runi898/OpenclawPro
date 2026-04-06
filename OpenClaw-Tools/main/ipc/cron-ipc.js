const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const DEFAULT_GATEWAY_SCOPES = Object.freeze([
    'operator.admin',
    'operator.read',
    'operator.write',
    'operator.approvals',
    'operator.pairing'
]);

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function registerCronIpcHandlers(deps = {}) {
    const {
        ipcMain,
        fs,
        openClawHomeDir,
        readCronJobsStoreSync,
        normalizeCronJobList,
        buildCronStatusFromStore,
        runOpenClawCliCaptured,
        parseCliJsonOutput,
        buildCronJobArgs
    } = deps;

    let gatewayRuntimeModulePromise = null;

    function getCliErrorMessage(result, fallbackMessage) {
        return String(
            result?.stderr
            || result?.stdout
            || result?.error?.message
            || fallbackMessage
            || 'OpenClaw CLI 执行失败'
        ).trim();
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value ?? null));
    }

    function shouldUseCli(payload = {}) {
        return payload?.preferCli === true || payload?.source === 'cli';
    }

    function getOpenClawConfigPath() {
        return path.join(String(openClawHomeDir || '').trim(), 'openclaw.json');
    }

    function readOpenClawConfigSafe() {
        const configPath = getOpenClawConfigPath();
        try {
            if (!configPath || !fs.existsSync(configPath)) return {};
            const rawText = fs.readFileSync(configPath, 'utf8');
            const parsed = JSON.parse(rawText);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            console.warn('[Cron] Failed to read gateway config:', error.message);
            return {};
        }
    }

    function resolveGatewayToken(config = {}) {
        const gateway = config?.gateway || {};
        const candidates = [
            gateway?.auth?.token,
            gateway?.token,
            gateway?.remote?.token,
            gateway?.controlUi?.token,
            gateway?.controlUi?.auth?.token,
            gateway?.control_ui?.token,
            gateway?.control_ui?.auth?.token,
            gateway?.accessToken,
            gateway?.access_token
        ];
        return candidates
            .map((value) => String(value || '').trim())
            .find(Boolean) || '';
    }

    function resolveGatewayPassword(config = {}) {
        const gateway = config?.gateway || {};
        const candidates = [
            gateway?.auth?.password,
            gateway?.password,
            gateway?.remote?.password,
            gateway?.controlUi?.password,
            gateway?.controlUi?.auth?.password,
            gateway?.control_ui?.password,
            gateway?.control_ui?.auth?.password
        ];
        return candidates
            .map((value) => String(value || '').trim())
            .find(Boolean) || '';
    }

    function trimTrailingSlash(value = '') {
        return String(value || '').replace(/\/+$/, '');
    }

    function resolveGatewayWsUrl(config = {}) {
        const gatewayMode = String(config?.gateway?.mode || '').trim().toLowerCase();
        const remoteUrl = trimTrailingSlash(String(config?.gateway?.remote?.url || ''));
        if (gatewayMode === 'remote' && remoteUrl) {
            if (/^wss?:\/\//i.test(remoteUrl)) return remoteUrl;
            if (/^https?:\/\//i.test(remoteUrl)) return remoteUrl.replace(/^http/i, 'ws');
        }

        const rawPort = Number.parseInt(String(config?.gateway?.port ?? ''), 10);
        const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 18789;
        const secure = config?.gateway?.tls?.enabled === true;
        return `${secure ? 'wss' : 'ws'}://127.0.0.1:${port}`;
    }

    function derivePublicKeyRaw(publicKeyPem) {
        const spki = crypto.createPublicKey(publicKeyPem).export({
            type: 'spki',
            format: 'der'
        });
        if (
            spki.length === ED25519_SPKI_PREFIX.length + 32
            && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
        ) {
            return spki.subarray(ED25519_SPKI_PREFIX.length);
        }
        return spki;
    }

    function fingerprintPublicKey(publicKeyPem) {
        return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
    }

    function generateDeviceIdentity() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const publicKeyPem = publicKey.export({
            type: 'spki',
            format: 'pem'
        }).toString();
        const privateKeyPem = privateKey.export({
            type: 'pkcs8',
            format: 'pem'
        }).toString();
        return {
            deviceId: fingerprintPublicKey(publicKeyPem),
            publicKeyPem,
            privateKeyPem
        };
    }

    function getDeviceIdentityPath() {
        return path.join(String(openClawHomeDir || '').trim() || path.join(os.homedir(), '.openclaw'), 'identity', 'device.json');
    }

    function loadOrCreateDeviceIdentity() {
        const filePath = getDeviceIdentityPath();
        try {
            if (fs.existsSync(filePath)) {
                const rawText = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(rawText);
                if (
                    parsed?.version === 1
                    && typeof parsed?.publicKeyPem === 'string'
                    && typeof parsed?.privateKeyPem === 'string'
                ) {
                    const deviceId = parsed?.deviceId || fingerprintPublicKey(parsed.publicKeyPem);
                    return {
                        deviceId,
                        publicKeyPem: parsed.publicKeyPem,
                        privateKeyPem: parsed.privateKeyPem
                    };
                }
            }
        } catch (error) {
            console.warn('[Cron] Failed to read device identity, regenerating:', error.message);
        }

        const identity = generateDeviceIdentity();
        const stored = {
            version: 1,
            deviceId: identity.deviceId,
            publicKeyPem: identity.publicKeyPem,
            privateKeyPem: identity.privateKeyPem,
            createdAtMs: Date.now()
        };
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
        try {
            fs.chmodSync(filePath, 0o600);
        } catch (_) {}
        return identity;
    }

    function resolveOpenClawPackageRoot() {
        const appDataRoot = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const candidates = [
            process.env.OPENCLAW_PACKAGE_ROOT,
            path.join(appDataRoot, 'npm', 'node_modules', 'openclaw')
        ]
            .map((value) => String(value || '').trim())
            .filter(Boolean);

        for (const candidate of candidates) {
            if (fs.existsSync(path.join(candidate, 'package.json'))) {
                return candidate;
            }
        }

        throw new Error('未找到 openclaw 运行时包，无法启用 Gateway RPC 快速通道');
    }

    async function loadGatewayRuntimeModule() {
        if (!gatewayRuntimeModulePromise) {
            gatewayRuntimeModulePromise = (async () => {
                const packageRoot = resolveOpenClawPackageRoot();
                const moduleUrl = pathToFileURL(path.join(packageRoot, 'dist', 'plugin-sdk', 'gateway-runtime.js')).href;
                const mod = await import(moduleUrl);
                if (typeof mod?.GatewayClient !== 'function') {
                    throw new Error('OpenClaw GatewayClient 模块不可用');
                }
                return mod;
            })().catch((error) => {
                gatewayRuntimeModulePromise = null;
                throw error;
            });
        }

        return gatewayRuntimeModulePromise;
    }

    async function requestGateway(method, params = {}, options = {}) {
        const config = readOpenClawConfigSafe();
        const { GatewayClient } = await loadGatewayRuntimeModule();
        const timeoutMs = Math.max(1000, Number(options?.timeoutMs) || 10000);
        const wsUrl = resolveGatewayWsUrl(config);
        const token = resolveGatewayToken(config);
        const password = resolveGatewayPassword(config);
        const deviceIdentity = loadOrCreateDeviceIdentity();
        const scopes = Array.isArray(options?.scopes) && options.scopes.length
            ? options.scopes
            : DEFAULT_GATEWAY_SCOPES;

        return await new Promise((resolve, reject) => {
            let settled = false;
            let client = null;
            let timeoutId = null;

            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                if (timeoutId) clearTimeout(timeoutId);
                try {
                    client?.stop?.();
                } catch (_) {}
                if (error) reject(error);
                else resolve(value);
            };

            client = new GatewayClient({
                url: wsUrl,
                token: token || undefined,
                password: password || undefined,
                clientName: 'cli',
                mode: 'cli',
                role: 'operator',
                scopes,
                instanceId: crypto.randomUUID(),
                deviceIdentity,
                onHelloOk: async () => {
                    try {
                        const result = await client.request(method, params, {
                            expectFinal: options?.expectFinal === true,
                            timeoutMs
                        });
                        finish(null, result);
                    } catch (error) {
                        finish(error);
                    }
                },
                onConnectError: (error) => {
                    finish(error instanceof Error ? error : new Error(String(error)));
                },
                onClose: (code, reason) => {
                    if (settled) return;
                    finish(new Error(`Gateway 连接已关闭 (${code}): ${String(reason || '').trim() || 'unknown reason'}`));
                }
            });

            timeoutId = setTimeout(() => {
                finish(new Error(`Gateway 请求超时（${method}，${timeoutMs}ms）`));
            }, timeoutMs + 3000);

            client.start();
        });
    }

    function parseEveryToMs(value = '') {
        const text = String(value || '').trim();
        const match = text.match(/^(\d+)\s*([smhd])$/i);
        if (!match) return 0;
        const amount = Number(match[1] || 0);
        const unit = String(match[2] || '').toLowerCase();
        if (!amount) return 0;
        if (unit === 's') return amount * 1000;
        if (unit === 'm') return amount * 60000;
        if (unit === 'h') return amount * 3600000;
        if (unit === 'd') return amount * 86400000;
        return 0;
    }

    function buildGatewaySchedule(payload = {}, existingSchedule = {}) {
        const scheduleMode = String(payload?.scheduleMode || '').trim().toLowerCase();
        const cronValue = String(payload?.cron || '').trim();
        const everyValue = String(payload?.every || '').trim();
        const atValue = String(payload?.at || '').trim();
        const tzValue = String(payload?.tz || '').trim();
        let schedule = cloneJson(existingSchedule || {}) || {};

        if (scheduleMode === 'every' || everyValue) {
            const everyMs = parseEveryToMs(everyValue);
            if (!everyMs) {
                throw new Error('间隔执行格式无效，请使用如 30m / 1h');
            }
            schedule = {
                kind: 'every',
                everyMs
            };
        } else if (scheduleMode === 'at' || atValue) {
            if (!atValue) throw new Error('指定时间不能为空');
            schedule = {
                kind: 'at',
                at: atValue
            };
        } else {
            if (!cronValue) throw new Error('cron 表达式不能为空');
            schedule = {
                kind: 'cron',
                expr: cronValue
            };
        }

        if (tzValue) {
            schedule.tz = tzValue;
        } else if (schedule && typeof schedule === 'object' && 'tz' in schedule) {
            delete schedule.tz;
        }

        return schedule;
    }

    function buildGatewayTaskPayload(payload = {}, existingPayload = {}) {
        const sessionTarget = String(payload?.sessionTarget || '').trim().toLowerCase() || 'isolated';
        const systemEvent = String(payload?.systemEvent || '').trim();
        const message = String(payload?.message || '').trim();
        const model = String(payload?.model || '').trim();
        const thinking = String(payload?.thinking || '').trim();

        if (sessionTarget === 'main' && systemEvent) {
            return {
                kind: 'systemEvent',
                text: systemEvent
            };
        }

        const current = existingPayload && typeof existingPayload === 'object' ? existingPayload : {};
        const nextPayload = {
            kind: 'agentTurn',
            message: message || String(current?.message || '').trim()
        };

        if (model) nextPayload.model = model;
        if (thinking && thinking !== 'medium') nextPayload.thinking = thinking;

        return nextPayload;
    }

    function buildGatewayDelivery(payload = {}, existingDelivery = {}) {
        const channel = String(payload?.channel || '').trim();
        const to = String(payload?.to || '').trim();
        const deliveryMode = payload?.announce === true ? 'announce' : 'none';
        const delivery = {
            mode: deliveryMode
        };

        if (channel) delivery.channel = channel;
        if (to) delivery.to = to;

        if (!channel && !to && existingDelivery && typeof existingDelivery === 'object' && payload?.announce !== true) {
            return {
                mode: 'none'
            };
        }

        return delivery;
    }

    function buildGatewayCreateParams(payload = {}) {
        const params = {
            name: String(payload?.name || '').trim(),
            enabled: payload?.enabled !== false,
            schedule: buildGatewaySchedule(payload),
            payload: buildGatewayTaskPayload(payload),
            delivery: buildGatewayDelivery(payload),
            sessionTarget: String(payload?.sessionTarget || 'isolated').trim() || 'isolated'
        };

        const description = String(payload?.description || '').trim();
        if (description) params.description = description;

        const agentId = String(payload?.agentId || '').trim();
        if (agentId && agentId !== 'main') {
            params.agentId = agentId;
        }

        return params;
    }

    function buildGatewayUpdateParams(payload = {}, existingJob = null) {
        const safeExistingJob = existingJob && typeof existingJob === 'object' ? existingJob : {};
        const jobId = String(payload?.id || safeExistingJob?.id || '').trim();
        if (!jobId) throw new Error('缺少定时任务 ID');

        const patch = {
            name: String(payload?.name || '').trim(),
            description: String(payload?.description || '').trim(),
            enabled: payload?.enabled !== false,
            schedule: buildGatewaySchedule(payload, safeExistingJob?.schedule || {}),
            payload: buildGatewayTaskPayload(payload, safeExistingJob?.payload || {}),
            delivery: buildGatewayDelivery(payload, safeExistingJob?.delivery || {}),
            sessionTarget: String(payload?.sessionTarget || safeExistingJob?.sessionTarget || 'isolated').trim() || 'isolated'
        };

        const agentId = String(payload?.agentId || '').trim();
        if (agentId && agentId !== 'main') {
            patch.agentId = agentId;
        } else {
            patch.agentId = null;
        }

        return {
            jobId,
            patch
        };
    }

    async function findGatewayJobById(jobId, timeoutMs = 10000) {
        const listResult = await requestGateway('cron.list', { includeDisabled: true }, { timeoutMs });
        const jobs = Array.isArray(listResult?.jobs) ? listResult.jobs : Array.isArray(listResult) ? listResult : [];
        return jobs.find((job) => String(job?.id || '').trim() === String(jobId || '').trim()) || null;
    }

    async function listCronJobsViaCli(payload = {}) {
        const result = await runOpenClawCliCaptured(['cron', 'list', '--all', '--json'], {
            timeoutMs: Number(payload?.timeoutMs) || 30000
        });
        if (!result.ok) {
            throw new Error(String(result.stderr || result.stdout || result.error?.message || '定时任务列表获取失败').trim());
        }

        const parsed = parseCliJsonOutput(result.stdout);
        return {
            ok: true,
            jobs: normalizeCronJobList(parsed),
            raw: parsed,
            source: 'gateway-cli'
        };
    }

    async function getCronStatusViaCli(payload = {}) {
        const result = await runOpenClawCliCaptured(['cron', 'status', '--json'], {
            timeoutMs: Number(payload?.timeoutMs) || 30000
        });
        if (!result.ok) {
            throw new Error(String(result.stderr || result.stdout || result.error?.message || '定时任务状态获取失败').trim());
        }

        const parsed = parseCliJsonOutput(result.stdout);
        return {
            ok: true,
            status: parsed,
            source: 'gateway-cli'
        };
    }

    async function createCronJobViaCli(payload = {}) {
        const args = [...buildCronJobArgs(payload, 'add'), '--json'];
        const result = await runOpenClawCliCaptured(args, {
            direct: true,
            timeoutMs: Number(payload?.timeoutMs) || 30000
        });
        if (!result.ok) {
            throw new Error(getCliErrorMessage(result, '创建定时任务失败'));
        }

        return {
            ok: true,
            result: parseCliJsonOutput(result.stdout),
            stdout: result.stdout,
            source: 'gateway-cli'
        };
    }

    async function updateCronJobViaCli(payload = {}) {
        const args = buildCronJobArgs(payload, 'edit');
        const result = await runOpenClawCliCaptured(args, {
            direct: true,
            timeoutMs: Number(payload?.timeoutMs) || 30000
        });
        if (!result.ok) {
            throw new Error(getCliErrorMessage(result, '更新定时任务失败'));
        }

        return {
            ok: true,
            stdout: result.stdout,
            source: 'gateway-cli'
        };
    }

    async function toggleCronJobViaCli(payload = {}) {
        const enabled = payload?.enabled !== false;
        const result = await runOpenClawCliCaptured(['cron', enabled ? 'enable' : 'disable', String(payload?.id || '').trim()], {
            direct: true,
            timeoutMs: Number(payload?.timeoutMs) || 30000
        });
        if (!result.ok) {
            throw new Error(getCliErrorMessage(result, '切换定时任务状态失败'));
        }

        return {
            ok: true,
            source: 'gateway-cli'
        };
    }

    async function removeCronJobViaCli(payload = {}) {
        const result = await runOpenClawCliCaptured(['cron', 'rm', String(payload?.id || '').trim(), '--json'], {
            direct: true,
            timeoutMs: Number(payload?.timeoutMs) || 30000
        });
        if (!result.ok) {
            throw new Error(getCliErrorMessage(result, '删除定时任务失败'));
        }

        return {
            ok: true,
            result: parseCliJsonOutput(result.stdout),
            stdout: result.stdout,
            source: 'gateway-cli'
        };
    }

    async function runCronJobViaCli(payload = {}) {
        const result = await runOpenClawCliCaptured(['cron', 'run', String(payload?.id || '').trim()], {
            direct: true,
            timeoutMs: Number(payload?.timeoutMs) || 30000
        });
        if (!result.ok) {
            throw new Error(getCliErrorMessage(result, '手动执行定时任务失败'));
        }

        return {
            ok: true,
            stdout: result.stdout,
            source: 'gateway-cli'
        };
    }

    ipcMain.handle('list-cron-jobs', async (_, payload = {}) => {
        if (shouldUseCli(payload)) {
            try {
                return await listCronJobsViaCli(payload);
            } catch (error) {
                return {
                    ok: false,
                    error: error.message,
                    jobs: []
                };
            }
        }

        try {
            const gatewayResult = await requestGateway('cron.list', { includeDisabled: true }, {
                timeoutMs: Number(payload?.timeoutMs) || 10000,
                scopes: ['operator.read']
            });
            return {
                ok: true,
                jobs: normalizeCronJobList(gatewayResult),
                raw: gatewayResult,
                source: 'gateway-rpc'
            };
        } catch (gatewayError) {
            console.error('[Cron] Gateway list failed:', gatewayError.message);
            try {
                const cliResult = await listCronJobsViaCli(payload);
                return {
                    ...cliResult,
                    warning: gatewayError.message,
                    source: 'gateway-cli-fallback'
                };
            } catch (cliError) {
                console.error('[Cron] CLI list fallback failed:', cliError.message);
                const store = readCronJobsStoreSync();
                if (store.ok) {
                    return {
                        ok: true,
                        jobs: normalizeCronJobList(store.jobs),
                        raw: store.raw,
                        source: store.source === 'local-store-empty' ? 'local-store-empty' : 'local-store-fallback',
                        storePath: store.path,
                        warning: gatewayError.message || cliError.message
                    };
                }
                return {
                    ok: false,
                    error: gatewayError.message || cliError.message,
                    jobs: []
                };
            }
        }
    });

    ipcMain.handle('get-cron-status', async (_, payload = {}) => {
        if (shouldUseCli(payload)) {
            try {
                return await getCronStatusViaCli(payload);
            } catch (error) {
                return {
                    ok: false,
                    error: error.message,
                    status: null
                };
            }
        }

        try {
            const gatewayResult = await requestGateway('cron.status', {}, {
                timeoutMs: Number(payload?.timeoutMs) || 10000,
                scopes: ['operator.read']
            });
            return {
                ok: true,
                status: gatewayResult,
                source: 'gateway-rpc'
            };
        } catch (gatewayError) {
            console.error('[Cron] Gateway status failed:', gatewayError.message);
            try {
                const cliResult = await getCronStatusViaCli(payload);
                return {
                    ...cliResult,
                    warning: gatewayError.message,
                    source: 'gateway-cli-fallback'
                };
            } catch (cliError) {
                console.error('[Cron] CLI status fallback failed:', cliError.message);
                const store = readCronJobsStoreSync();
                if (store.ok) {
                    return {
                        ok: true,
                        status: buildCronStatusFromStore(store),
                        source: store.source === 'local-store-empty' ? 'local-store-empty' : 'local-store-fallback',
                        warning: gatewayError.message || cliError.message
                    };
                }
                return {
                    ok: false,
                    error: gatewayError.message || cliError.message,
                    status: null
                };
            }
        }
    });

    ipcMain.handle('create-cron-job', async (_, payload = {}) => {
        try {
            if (!shouldUseCli(payload)) {
                const params = buildGatewayCreateParams(payload);
                const result = await requestGateway('cron.add', params, {
                    timeoutMs: Number(payload?.timeoutMs) || 10000,
                    scopes: ['operator.admin']
                });
                return {
                    ok: true,
                    result,
                    source: 'gateway-rpc'
                };
            }

            return await createCronJobViaCli(payload);
        } catch (gatewayError) {
            if (!shouldUseCli(payload)) {
                console.error('[Cron] Gateway create failed:', gatewayError.message);
                try {
                    const cliResult = await createCronJobViaCli(payload);
                    return {
                        ...cliResult,
                        warning: gatewayError.message,
                        source: 'gateway-cli-fallback'
                    };
                } catch (cliError) {
                    console.error('[Cron] CLI create fallback failed:', cliError.message);
                }
            }

            return {
                ok: false,
                error: gatewayError.message
            };
        }
    });

    ipcMain.handle('update-cron-job', async (_, payload = {}) => {
        try {
            if (!shouldUseCli(payload)) {
                const existingJob = await findGatewayJobById(payload?.id, Number(payload?.timeoutMs) || 10000);
                const params = buildGatewayUpdateParams(payload, existingJob);
                const result = await requestGateway('cron.update', params, {
                    timeoutMs: Number(payload?.timeoutMs) || 10000,
                    scopes: ['operator.admin']
                });
                return {
                    ok: true,
                    result,
                    source: 'gateway-rpc'
                };
            }

            return await updateCronJobViaCli(payload);
        } catch (gatewayError) {
            if (!shouldUseCli(payload)) {
                console.error('[Cron] Gateway update failed:', gatewayError.message);
                try {
                    const cliResult = await updateCronJobViaCli(payload);
                    return {
                        ...cliResult,
                        warning: gatewayError.message,
                        source: 'gateway-cli-fallback'
                    };
                } catch (cliError) {
                    console.error('[Cron] CLI update fallback failed:', cliError.message);
                }
            }

            return {
                ok: false,
                error: gatewayError.message
            };
        }
    });

    ipcMain.handle('toggle-cron-job', async (_, payload = {}) => {
        try {
            const jobId = String(payload?.id || '').trim();
            if (!jobId) throw new Error('缺少定时任务 ID');

            if (!shouldUseCli(payload)) {
                const result = await requestGateway('cron.update', {
                    id: jobId,
                    patch: {
                        enabled: payload?.enabled !== false
                    }
                }, {
                    timeoutMs: Number(payload?.timeoutMs) || 10000,
                    scopes: ['operator.admin']
                });
                return {
                    ok: true,
                    result,
                    source: 'gateway-rpc'
                };
            }

            return await toggleCronJobViaCli(payload);
        } catch (gatewayError) {
            if (!shouldUseCli(payload)) {
                console.error('[Cron] Gateway toggle failed:', gatewayError.message);
                try {
                    const cliResult = await toggleCronJobViaCli(payload);
                    return {
                        ...cliResult,
                        warning: gatewayError.message,
                        source: 'gateway-cli-fallback'
                    };
                } catch (cliError) {
                    console.error('[Cron] CLI toggle fallback failed:', cliError.message);
                }
            }

            return {
                ok: false,
                error: gatewayError.message
            };
        }
    });

    ipcMain.handle('remove-cron-job', async (_, payload = {}) => {
        try {
            const jobId = String(payload?.id || '').trim();
            if (!jobId) throw new Error('缺少定时任务 ID');

            if (!shouldUseCli(payload)) {
                const result = await requestGateway('cron.remove', { id: jobId }, {
                    timeoutMs: Number(payload?.timeoutMs) || 10000,
                    scopes: ['operator.admin']
                });
                return {
                    ok: true,
                    result,
                    source: 'gateway-rpc'
                };
            }

            return await removeCronJobViaCli(payload);
        } catch (gatewayError) {
            if (!shouldUseCli(payload)) {
                console.error('[Cron] Gateway remove failed:', gatewayError.message);
                try {
                    const cliResult = await removeCronJobViaCli(payload);
                    return {
                        ...cliResult,
                        warning: gatewayError.message,
                        source: 'gateway-cli-fallback'
                    };
                } catch (cliError) {
                    console.error('[Cron] CLI remove fallback failed:', cliError.message);
                }
            }

            return {
                ok: false,
                error: gatewayError.message
            };
        }
    });

    ipcMain.handle('run-cron-job', async (_, payload = {}) => {
        try {
            const jobId = String(payload?.id || '').trim();
            if (!jobId) throw new Error('缺少定时任务 ID');

            if (!shouldUseCli(payload)) {
                const result = await requestGateway('cron.run', { id: jobId }, {
                    timeoutMs: Number(payload?.timeoutMs) || 10000,
                    scopes: ['operator.admin']
                });
                return {
                    ok: true,
                    result,
                    source: 'gateway-rpc'
                };
            }

            return await runCronJobViaCli(payload);
        } catch (gatewayError) {
            if (!shouldUseCli(payload)) {
                console.error('[Cron] Gateway run failed:', gatewayError.message);
                try {
                    const cliResult = await runCronJobViaCli(payload);
                    return {
                        ...cliResult,
                        warning: gatewayError.message,
                        source: 'gateway-cli-fallback'
                    };
                } catch (cliError) {
                    console.error('[Cron] CLI run fallback failed:', cliError.message);
                }
            }

            return {
                ok: false,
                error: gatewayError.message
            };
        }
    });
}

module.exports = {
    registerCronIpcHandlers
};
