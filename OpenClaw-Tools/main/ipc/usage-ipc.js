function registerUsageIpcHandlers(deps = {}) {
    const {
        ipcMain,
        openClawHomeDir,
        buildUsageReport,
        readUsageReportCache,
        writeUsageReportCache
    } = deps;

    ipcMain.handle('get-usage-report', (_, payload = {}) => {
        try {
            const days = Math.max(1, Number(payload?.days) || 7);
            const forceRefresh = payload?.forceRefresh === true;
            if (!forceRefresh) {
                const cachedReport = readUsageReportCache(days);
                if (cachedReport) {
                    return {
                        ok: true,
                        report: cachedReport,
                        cached: true
                    };
                }
            }

            const report = writeUsageReportCache(
                days,
                buildUsageReport(openClawHomeDir, days)
            );
            return {
                ok: true,
                report,
                cached: false
            };
        } catch (error) {
            console.error('[Usage] Report failed:', error.message);
            return {
                ok: false,
                error: error.message,
                report: null
            };
        }
    });
}

module.exports = {
    registerUsageIpcHandlers
};
