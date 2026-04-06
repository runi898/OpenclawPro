const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const action = String(process.argv[2] || '').trim();
const runtime = {
    nodeExe: String(process.env.OPENCLAW_NODE_EXE || '').trim(),
    pm2Cli: String(process.env.OPENCLAW_PM2_CLI || '').trim(),
    appName: String(process.env.OPENCLAW_PM2_APP_NAME || 'openclaw-gateway').trim(),
    configPath: String(process.env.OPENCLAW_PM2_CONFIG_PATH || '').trim(),
    outLogPath: String(process.env.OPENCLAW_PM2_OUT_LOG || '').trim(),
    errLogPath: String(process.env.OPENCLAW_PM2_ERR_LOG || '').trim(),
    serviceStartupVbsPath: String(process.env.OPENCLAW_SERVICE_STARTUP_VBS || '').trim(),
    startupFolderPath: String(process.env.OPENCLAW_STARTUP_DIR || '').trim(),
    startupVbsPath: String(process.env.OPENCLAW_STARTUP_VBS || '').trim()
};

function print(line = '') {
    process.stdout.write(`${line}${os.EOL}`);
}

function printError(line) {
    process.stderr.write(`${line}${os.EOL}`);
}

function printBlank() {
    print('');
}

function printSection(title) {
    print(title);
}

function printInfo(text) {
    print(text);
}

function printWarn(text) {
    print(text);
}

function printSuccess(text) {
    print(text);
}

function printCommand(text) {
    print(`[执行命令] ${text}`);
}

function exitWithError(message, code = 1) {
    printError(message);
    process.exit(code);
}

function quoteArg(value) {
    const text = String(value ?? '');
    if (!text) return '""';
    if (!/[\s"]/u.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
}

function buildPm2DisplayCommand(args) {
    return ['pm2', ...args.map(quoteArg)].join(' ');
}

function runPm2(args, extraOptions = {}) {
    return spawnSync(runtime.nodeExe, [runtime.pm2Cli, ...args], {
        windowsHide: true,
        encoding: 'utf8',
        ...extraOptions
    });
}

function runPm2Verbose(args, options = {}) {
    const {
        flush = true,
        ignoreFailure = false
    } = options;
    printCommand(buildPm2DisplayCommand(args));
    const result = runPm2(args);
    if (flush) {
        flushResult(result);
    }
    if (!ignoreFailure && (result.error || result.status !== 0)) {
        const message = result.error?.message || String(result.stderr || result.stdout || '').trim() || 'PM2 执行失败。';
        exitWithError(`[PM2] ${message}`);
    }
    return result;
}

function flushResult(result) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
}

function ensureRuntimeForPm2(requireConfig = true) {
    if (!runtime.nodeExe || !fs.existsSync(runtime.nodeExe)) {
        exitWithError('[PM2] 未找到 node.exe。');
    }
    if (!runtime.pm2Cli || !fs.existsSync(runtime.pm2Cli)) {
        exitWithError('[PM2] 未找到 PM2 CLI。');
    }
    if (requireConfig && (!runtime.configPath || !fs.existsSync(runtime.configPath))) {
        exitWithError(`[PM2] 未找到 OpenClaw PM2 配置: ${runtime.configPath}`);
    }
}

function readTail(filePath, lines = 10) {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const text = fs.readFileSync(filePath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join(os.EOL);
}

function showRecentLogs() {
    const chunks = [];
    const outTail = readTail(runtime.outLogPath, 10);
    const errTail = readTail(runtime.errLogPath, 10);

    if (outTail) {
        chunks.push(`[OUT] ${runtime.outLogPath}`);
        chunks.push(outTail);
    }
    if (errTail) {
        if (chunks.length) chunks.push('');
        chunks.push(`[ERR] ${runtime.errLogPath}`);
        chunks.push(errTail);
    }

    if (!chunks.length) {
        printWarn('未找到最近日志。');
        return;
    }

    print(chunks.join(os.EOL));
}

function getOpenClawPm2Apps() {
    const result = runPm2(['jlist']);
    if (result.error || result.status !== 0) {
        return [];
    }

    const raw = String(result.stdout || '').trim();
    if (!raw) return [];

    let apps = [];
    try {
        apps = JSON.parse(raw);
    } catch (_) {
        return [];
    }

    return [...new Set((Array.isArray(apps) ? apps : [])
        .filter((app) => {
            const name = String(app?.name || '');
            const execPath = String(app?.pm2_env?.pm_exec_path || '');
            const rawArgs = app?.pm2_env?.args;
            const args = Array.isArray(rawArgs) ? rawArgs.join(' ') : String(rawArgs || '');
            return `${name} ${execPath} ${args}`.toLowerCase().includes('openclaw');
        })
        .map((app) => String(app?.name || '').trim())
        .filter(Boolean)
    )];
}

function isAppOnline(appName) {
    const result = runPm2(['jlist']);
    if (result.error || result.status !== 0) return false;

    let apps = [];
    try {
        apps = JSON.parse(String(result.stdout || '[]'));
    } catch (_) {
        return false;
    }

    return (Array.isArray(apps) ? apps : []).some((app) => {
        const name = String(app?.name || '').trim();
        const status = String(app?.pm2_env?.status || '').trim().toLowerCase();
        return name === appName && status === 'online';
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirectory(dirPath) {
    if (!dirPath) return;
    if (fs.existsSync(dirPath)) return;
    printCommand(`mkdir ${quoteArg(dirPath)}`);
    fs.mkdirSync(dirPath, { recursive: true });
}

function ensureServiceStartupVbs() {
    if (runtime.serviceStartupVbsPath && fs.existsSync(runtime.serviceStartupVbsPath)) {
        return;
    }

    if (!runtime.serviceStartupVbsPath) {
        exitWithError('[自启动] 缺少服务端 VBS 路径配置。');
    }

    ensureRuntimeForPm2(false);
    ensureDirectory(path.dirname(runtime.serviceStartupVbsPath));
    const content = [
        'Set WshShell = CreateObject("WScript.Shell")',
        `WshShell.Run """${runtime.nodeExe}"" ""${runtime.pm2Cli}"" resurrect", 0, False`
    ].join('\r\n');
    printCommand(`write ${quoteArg(runtime.serviceStartupVbsPath)}`);
    fs.writeFileSync(runtime.serviceStartupVbsPath, content, 'utf8');
}

function printPm2List() {
    printSection('PM2 任务列表：');
    const result = runPm2Verbose(['list']);
    return result.status || 0;
}

function stopAllOpenClawPm2Apps(options = {}) {
    const {
        emptyMessage = '未发现运行中的 OpenClaw PM2 任务。'
    } = options;

    ensureRuntimeForPm2(false);
    const existingApps = getOpenClawPm2Apps();

    if (!existingApps.length) {
        printWarn(emptyMessage);
        return 0;
    }

    for (const name of existingApps) {
        printWarn(`正在停止 OpenClaw 任务：${name}`);
        runPm2Verbose(['stop', name], { flush: false, ignoreFailure: true });
        runPm2Verbose(['delete', name], { flush: false, ignoreFailure: true });
    }

    printSuccess(`已停止全部 ${existingApps.length} 个 OpenClaw PM2 任务。`);
    return existingApps.length;
}

async function runStartFlow() {
    ensureRuntimeForPm2(true);
    const existingApps = getOpenClawPm2Apps();

    if (existingApps.length) {
        for (const name of existingApps) {
            printWarn(`发现已存在的 OpenClaw 任务，先清理旧实例：${name}`);
            runPm2Verbose(['stop', name], { flush: false, ignoreFailure: true });
            runPm2Verbose(['delete', name], { flush: false, ignoreFailure: true });
        }
    } else {
        printInfo('未发现正在注册的 OpenClaw 实例。');
    }

    printBlank();
    printInfo('正在后台启动 OpenClaw...');
    runPm2Verbose(['start', runtime.configPath, '--only', runtime.appName]);

    for (let waitCount = 1; waitCount <= 15; waitCount += 1) {
        if (isAppOnline(runtime.appName)) {
            runPm2Verbose(['save', '--force'], { flush: false, ignoreFailure: true });
            printBlank();
            printSection('PM2 状态：');
            runPm2Verbose(['list']);
            printBlank();
            printSection('最近日志：');
            showRecentLogs();
            process.exit(0);
        }
        await sleep(1000);
    }

    printBlank();
    printSection('PM2 状态：');
    runPm2Verbose(['list']);
    printBlank();
    printSection('最近日志：');
    showRecentLogs();
    printBlank();
    exitWithError('OpenClaw 启动检查超时。', 1);
}

function runStopFlow() {
    stopAllOpenClawPm2Apps();
    process.exit(0);
}

async function runRestartFlow() {
    ensureRuntimeForPm2(true);
    printWarn('正在重启 OpenClaw（会先清理全部 OpenClaw 任务）...');
    await runStartFlow();
}

function runEnableAutostart() {
    if (!runtime.startupFolderPath || !runtime.startupVbsPath) {
        exitWithError('[自启动] 缺少启动目录配置。');
    }

    ensureRuntimeForPm2(false);
    printInfo('正在启用开机自启...');
    ensureDirectory(runtime.startupFolderPath);
    ensureServiceStartupVbs();
    printCommand(`copy /y ${quoteArg(runtime.serviceStartupVbsPath)} ${quoteArg(runtime.startupVbsPath)}`);
    fs.copyFileSync(runtime.serviceStartupVbsPath, runtime.startupVbsPath);
    printSuccess('已启用开机自启。');
}

function runDisableAutostart() {
    if (!runtime.startupVbsPath) {
        exitWithError('[自启动] 缺少启动 VBS 路径配置。');
    }

    printInfo('正在禁用开机自启...');
    printCommand(`del /f /q ${quoteArg(runtime.startupVbsPath)}`);
    if (fs.existsSync(runtime.startupVbsPath)) {
        fs.rmSync(runtime.startupVbsPath, { force: true });
    }
    printSuccess('已禁用开机自启。');
}

async function main() {
    switch (action) {
        case 'start':
            await runStartFlow();
            return;
        case 'stop':
            runStopFlow();
            return;
        case 'restart':
            await runRestartFlow();
            return;
        case 'enable-autostart':
            runEnableAutostart();
            return;
        case 'disable-autostart':
            runDisableAutostart();
            return;
        case 'list-tasks':
            ensureRuntimeForPm2(false);
            process.exit(printPm2List());
            return;
        default:
            exitWithError(`[PM2] 不支持的动作: ${action}`);
    }
}

main().catch((error) => {
    exitWithError(error?.message || String(error));
});
