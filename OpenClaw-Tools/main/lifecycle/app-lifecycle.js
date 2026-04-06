const path = require('path');

function createMainWindow(deps = {}) {
    const {
        BrowserWindow,
        appDir,
        setMainWindow
    } = deps;

    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: 'OpenClaw Pro 控制中心',
        backgroundColor: '#1e1e24',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(appDir, 'preload.js'),
            webviewTag: true
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');
    setMainWindow(mainWindow);
    return mainWindow;
}

function bootstrapAppLifecycle(deps = {}) {
    const {
        app,
        session,
        BrowserWindow,
        installSmokeFixtures,
        readOpenClawConfigSync,
        ensureMainOpenClawLayout,
        initSentinel,
        createWindow,
        scheduleConfigHealthCheck,
        isSmokeTest,
        getMainWindow,
        runSmokeTests,
        emitSmokeResult,
        dashboardFollowProcesses,
        stopDashboardLogFollowByKey
    } = deps;

    app.whenReady().then(() => {
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            const headers = { ...(details.responseHeaders || {}) };
            delete headers['x-frame-options'];
            delete headers['X-Frame-Options'];
            delete headers['content-security-policy'];
            delete headers['Content-Security-Policy'];
            callback({ cancel: false, responseHeaders: headers });
        });

        installSmokeFixtures();

        let initialConfig = {};
        try {
            initialConfig = readOpenClawConfigSync();
        } catch (error) {
            console.warn('[Config] Failed to read openclaw.json during bootstrap:', error.message);
        }

        ensureMainOpenClawLayout(initialConfig);
        initSentinel();
        createWindow();
        scheduleConfigHealthCheck('app-start', 2600);

        if (isSmokeTest) {
            getMainWindow()?.webContents.once('did-finish-load', () => {
                setTimeout(() => {
                    runSmokeTests().catch(error => {
                        emitSmokeResult({
                            ok: false,
                            results: [{ name: 'smoke-runner', ok: false, details: error.message }]
                        });
                    });
                }, 400);
            });
        }

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('before-quit', () => {
        Array.from(dashboardFollowProcesses.keys()).forEach((senderKey) => {
            stopDashboardLogFollowByKey(senderKey, { notify: false });
        });
    });
}

module.exports = {
    createMainWindow,
    bootstrapAppLifecycle
};
