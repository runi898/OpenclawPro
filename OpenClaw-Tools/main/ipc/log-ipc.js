function registerLogIpcHandlers(deps = {}) {
    const {
        ipcMain,
        fs,
        path,
        openClawHomeDir,
        getAgentSessionsPath,
        normalizeAgentName,
        isSubPath,
        readTail,
        resolveServiceLogPath,
        getAgentRootPath,
        getOpenClawMainLogPathCandidatesSync,
        runOpenClawCliCaptured
    } = deps;

    function normalizeGatewayLogPath(rawPath) {
        const text = String(rawPath || '').trim();
        if (!text) return '';
        if (/^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text)) {
            return path.win32.normalize(text);
        }
        if (/^[\\/](?![\\/])/.test(text)) {
            const drive = String(process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
            return path.win32.normalize(`${drive}${text}`);
        }
        return text;
    }

    function listGatewayLogFilesInDir(dirPath) {
        const resolvedDir = String(dirPath || '').trim();
        if (!resolvedDir || !fs.existsSync(resolvedDir)) return [];
        try {
            return fs.readdirSync(resolvedDir, { withFileTypes: true })
                .filter((entry) => entry.isFile() && /^openclaw-\d{4}-\d{2}-\d{2}\.log$/i.test(entry.name))
                .map((entry) => {
                    const filePath = path.join(resolvedDir, entry.name);
                    return {
                        path: filePath,
                        mtimeMs: fs.statSync(filePath).mtimeMs || 0
                    };
                });
        } catch (_) {
            return [];
        }
    }

    function readActiveGatewayLogFile(linesCount) {
        const pathCandidates = typeof getOpenClawMainLogPathCandidatesSync === 'function'
            ? getOpenClawMainLogPathCandidatesSync(new Date())
            : [];
        const driveRoot = String(process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
        const explicitDirs = [
            path.join(driveRoot, 'tmp', 'openclaw'),
            path.join(openClawHomeDir, 'tmp')
        ];
        const existingCandidates = pathCandidates
            .map((candidate) => String(candidate || '').trim())
            .filter((candidate) => candidate && fs.existsSync(candidate))
            .map((candidate) => ({
                path: candidate,
                mtimeMs: fs.statSync(candidate).mtimeMs || 0
            }))
            .concat(explicitDirs.flatMap((dirPath) => listGatewayLogFilesInDir(dirPath)))
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (!existingCandidates.length) return null;

        const activePath = existingCandidates[0].path;
        return {
            text: readTail(activePath, Number(linesCount) || 300),
            sourcePath: activePath,
            source: 'file'
        };
    }

    async function readActiveGatewayLogInfo(linesCount) {
        const directLog = readActiveGatewayLogFile(linesCount);
        if (directLog?.text || directLog?.sourcePath) {
            return directLog;
        }

        if (typeof runOpenClawCliCaptured !== 'function') return '';
        const limit = Math.max(50, Number(linesCount) || 300);
        const result = await runOpenClawCliCaptured(['logs', '--plain', '--limit', String(limit)], {
            direct: true,
            timeoutMs: 15000
        });
        if (!result?.ok) return null;

        const rawText = String(result.stdout || '').trim();
        if (!rawText) return null;

        const lines = rawText.split(/\r?\n/);
        let sourcePath = '';
        if (/^Log file:\s*/i.test(lines[0] || '')) {
            sourcePath = normalizeGatewayLogPath(lines.shift().replace(/^Log file:\s*/i, ''));
        }

        return {
            text: lines.join('\n').trim(),
            sourcePath,
            source: 'cli'
        };
    }

    function readGatewayFallbackLog(linesCount) {
        const candidates = [
            path.join(openClawHomeDir, 'gateway.log'),
            path.join(openClawHomeDir, 'logs', 'gateway.log'),
            path.join(getAgentRootPath('main'), 'gateway.log')
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return {
                    text: readTail(candidate, Number(linesCount) || 200),
                    sourcePath: candidate,
                    source: 'file'
                };
            }
        }

        return {
            text: '',
            sourcePath: '',
            source: ''
        };
    }

    ipcMain.handle('list-log-files', (_, agentName) => {
        try {
            const agent = normalizeAgentName(agentName || 'main');
            const dir = getAgentSessionsPath(agent);
            if (!fs.existsSync(dir)) return [];

            return fs.readdirSync(dir, { withFileTypes: true })
                .filter(entry => entry.isFile())
                .map(entry => {
                    const filePath = path.join(dir, entry.name);
                    return {
                        name: entry.name,
                        path: filePath,
                        mtime: fs.statSync(filePath).mtime.toISOString()
                    };
                })
                .sort((a, b) => b.mtime.localeCompare(a.mtime))
                .slice(0, 50);
        } catch (error) {
            console.error('[Logs] List failed:', error.message);
            return [];
        }
    });

    ipcMain.handle('read-log-file', (_, logFilePath, linesCount) => {
        try {
            const resolved = path.resolve(String(logFilePath || ''));
            if (!isSubPath(resolved, openClawHomeDir)) {
                throw new Error('Log path is outside the allowed range.');
            }
            if (!fs.existsSync(resolved)) return '';
            return readTail(resolved, Number(linesCount) || 200);
        } catch (error) {
            console.error('[Logs] Read failed:', error.message);
            return '';
        }
    });

    ipcMain.handle('read-service-log', async (_, logKey, linesCount) => {
        try {
            const normalizedKey = String(logKey || '').trim();
            if (normalizedKey === 'gateway') {
                const activeGatewayLog = await readActiveGatewayLogInfo(linesCount);
                if (activeGatewayLog?.text) return activeGatewayLog.text;
            }

            const target = resolveServiceLogPath(normalizedKey);
            if (!target || !fs.existsSync(target)) return '';
            return readTail(target, Number(linesCount) || 300);
        } catch (error) {
            console.error('[Logs] Read service log failed:', error.message);
            return '';
        }
    });

    ipcMain.handle('read-gateway-log', async (_, linesCount) => {
        try {
            const activeGatewayLog = await readActiveGatewayLogInfo(linesCount);
            if (activeGatewayLog?.text) return activeGatewayLog.text;
            return readGatewayFallbackLog(linesCount).text || '';
        } catch (error) {
            console.error('[Logs] Read gateway log failed:', error.message);
            return '';
        }
    });

    ipcMain.handle('read-gateway-log-details', async (_, linesCount) => {
        try {
            const activeGatewayLog = await readActiveGatewayLogInfo(linesCount);
            if (activeGatewayLog?.text || activeGatewayLog?.sourcePath) {
                return {
                    ok: true,
                    text: activeGatewayLog?.text || '',
                    path: activeGatewayLog?.sourcePath || '',
                    source: activeGatewayLog?.source || 'cli'
                };
            }

            const fallback = readGatewayFallbackLog(linesCount);
            return {
                ok: Boolean(fallback.text || fallback.sourcePath),
                text: fallback.text || '',
                path: fallback.sourcePath || '',
                source: fallback.source || 'file'
            };
        } catch (error) {
            console.error('[Logs] Read gateway log details failed:', error.message);
            return {
                ok: false,
                text: '',
                path: '',
                source: '',
                error: error.message
            };
        }
    });

    ipcMain.handle('get-active-gateway-log-source', async (_, linesCount) => {
        try {
            const activeGatewayLog = await readActiveGatewayLogInfo(linesCount);
            if (activeGatewayLog?.sourcePath) {
                return {
                    ok: true,
                    source: activeGatewayLog.source,
                    path: activeGatewayLog.sourcePath
                };
            }

            const fallback = readGatewayFallbackLog(linesCount);
            return {
                ok: Boolean(fallback.sourcePath),
                source: fallback.source || 'file',
                path: fallback.sourcePath || ''
            };
        } catch (error) {
            console.error('[Logs] Read active gateway log source failed:', error.message);
            return {
                ok: false,
                source: '',
                path: '',
                error: error.message
            };
        }
    });
}

module.exports = {
    registerLogIpcHandlers
};
