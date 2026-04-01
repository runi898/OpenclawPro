const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkPm2RuntimeInstalled } = require('./pm2-runtime-installer');

const openClawHomeDir = path.resolve(process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'));
const preferredServiceDir = path.join(openClawHomeDir, 'pm2-service');
const preferredConfigPath = path.join(preferredServiceDir, 'ecosystem.config.js');
const legacyWindowsServiceDir = process.platform === 'win32' ? 'C:\\openclaw-service' : '';
const startupFolderPath = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
);
const startupVbsPath = path.join(startupFolderPath, 'OpenClawSilent.vbs');
const shimAssetPath = path.join(__dirname, 'windows-hide-child-process.cjs');

const PACKAGE_PRIORITY = [
    {
        name: 'openclaw-cn',
        isCN: true,
        fallbackEntries: ['dist/entry.js', 'entry.js', 'openclaw.mjs']
    },
    {
        name: 'openclaw',
        isCN: false,
        fallbackEntries: ['openclaw.mjs', 'dist/entry.js', 'entry.js']
    }
];

function unique(items = []) {
    return [...new Set(items.filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function toPosixPath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function getPackageBinEntries(pkgJson) {
    if (!pkgJson || !pkgJson.bin) return [];
    if (typeof pkgJson.bin === 'string') return [pkgJson.bin];
    if (typeof pkgJson.bin === 'object') {
        return Object.values(pkgJson.bin).filter((value) => typeof value === 'string');
    }
    return [];
}

function getModuleRoots(options = {}) {
    const env = options.env || process.env;
    const roots = [];
    const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;

    if (prefix) {
        roots.push(path.join(prefix, 'node_modules'));
    }
    if (env.APPDATA) {
        roots.push(path.join(env.APPDATA, 'npm', 'node_modules'));
    }
    if (env.ProgramFiles) {
        roots.push(path.join(env.ProgramFiles, 'nodejs', 'node_modules'));
    }
    if (env['ProgramFiles(x86)']) {
        roots.push(path.join(env['ProgramFiles(x86)'], 'nodejs', 'node_modules'));
    }
    if (process.execPath) {
        roots.push(path.join(path.dirname(process.execPath), 'node_modules'));
    }
    if (Array.isArray(options.extraRoots)) {
        roots.push(...options.extraRoots);
    }

    return unique(roots).filter((root) => fs.existsSync(root));
}

function resolvePackageEntry(pkgDir, descriptor) {
    if (!fs.existsSync(pkgDir)) return null;
    const pkgJson = readJson(path.join(pkgDir, 'package.json'));
    const candidates = unique([
        ...getPackageBinEntries(pkgJson),
        ...descriptor.fallbackEntries
    ]).map((entry) => path.join(pkgDir, entry));
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveOpenClawEntry() {
    const moduleRoots = getModuleRoots();
    for (const descriptor of PACKAGE_PRIORITY) {
        for (const root of moduleRoots) {
            const pkgDir = path.join(root, descriptor.name);
            const entryPath = resolvePackageEntry(pkgDir, descriptor);
            if (entryPath) {
                return {
                    path: entryPath,
                    packageName: descriptor.name,
                    isCN: descriptor.isCN,
                    moduleRoot: root
                };
            }
        }
    }
    return null;
}

function ensureDirectory(dirPath) {
    if (!dirPath) return;
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function ensureFile(filePath, initialContent = '') {
    if (!filePath) return;
    ensureDirectory(path.dirname(filePath));
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, initialContent, 'utf8');
    }
}

function buildStartupVbsContent(nodeExe, pm2Cli) {
    return [
        'Set WshShell = CreateObject("WScript.Shell")',
        `WshShell.Run """${nodeExe}"" ""${pm2Cli}"" resurrect", 0, False`
    ].join('\r\n');
}

function buildEcosystemConfigText({ nodeExe, entryPath, packageName, serviceDir, serviceStartupVbsPath, shimTargetPath }) {
    const errorLogPath = path.join(serviceDir, 'error.log');
    const outLogPath = path.join(serviceDir, 'out.log');
    const envConfig = {
        NODE_ENV: 'production',
        OPENCLAW_HOME: openClawHomeDir,
        OPENCLAW_STATE_DIR: openClawHomeDir,
        OPENCLAW_CONFIG_PATH: path.join(openClawHomeDir, 'openclaw.json'),
        SERVICE_STARTUP_VBS: serviceStartupVbsPath,
        STARTUP_DIR: startupFolderPath,
        STARTUP_VBS: startupVbsPath,
        OPENCLAW_PM2_SERVICE_DIR: serviceDir,
        OPENCLAW_CLI_VARIANT: packageName || ''
    };

    if (shimTargetPath) {
        envConfig.NODE_OPTIONS = `--disable-warning=ExperimentalWarning --require=${toPosixPath(shimTargetPath)}`;
    }

    const apps = [{
        name: 'openclaw-gateway',
        script: toPosixPath(nodeExe),
        args: [toPosixPath(entryPath), 'gateway', '--port', '18789'],
        cwd: toPosixPath(serviceDir),
        windowsHide: true,
        autorestart: true,
        max_restarts: 3,
        min_uptime: '10s',
        restart_delay: 5000,
        error_file: toPosixPath(errorLogPath),
        out_file: toPosixPath(outLogPath),
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        env: envConfig
    }];

    return `module.exports = ${JSON.stringify({ apps }, null, 2)};\n`;
}

function findExistingPm2ServiceConfig() {
    const candidates = [
        preferredConfigPath,
        legacyWindowsServiceDir ? path.join(legacyWindowsServiceDir, 'ecosystem.config.js') : ''
    ].filter(Boolean);
    const configPath = candidates.find((candidate) => fs.existsSync(candidate)) || '';
    if (!configPath) {
        return {
            installed: false,
            configPath: '',
            serviceDir: preferredServiceDir,
            serviceStartupVbsPath: path.join(preferredServiceDir, 'OpenClawSilent.vbs'),
            startupVbsPath
        };
    }

    const serviceDir = path.dirname(configPath);
    return {
        installed: true,
        configPath,
        serviceDir,
        serviceStartupVbsPath: path.join(serviceDir, 'OpenClawSilent.vbs'),
        startupVbsPath
    };
}

function checkPm2ServiceInstalled() {
    const runtime = checkPm2RuntimeInstalled();
    const existing = findExistingPm2ServiceConfig();
    if (!runtime.ok) {
        return {
            ...runtime,
            serviceInstalled: false,
            configPath: existing.configPath,
            serviceDir: existing.serviceDir,
            serviceStartupVbsPath: existing.serviceStartupVbsPath,
            startupVbsPath: existing.startupVbsPath
        };
    }

    return {
        ok: true,
        installed: existing.installed,
        serviceInstalled: existing.installed,
        nodeExe: runtime.nodeExe,
        npmCli: runtime.npmCli,
        pm2Cli: runtime.pm2Cli,
        configPath: existing.configPath,
        serviceDir: existing.serviceDir,
        serviceStartupVbsPath: existing.serviceStartupVbsPath,
        startupVbsPath: existing.startupVbsPath,
        error: existing.installed ? '' : '当前环境未检测到 OpenClaw 的 PM2 服务配置。',
        logs: []
    };
}

function ensurePm2ServiceInstalled() {
    const initial = checkPm2ServiceInstalled();
    const logs = [];
    const startedAt = Date.now();

    if (!initial.ok) {
        return { ...initial, logs };
    }

    if (!initial.pm2Cli) {
        return {
            ...initial,
            ok: false,
            installed: false,
            serviceInstalled: false,
            error: '未检测到 PM2 CLI，无法初始化 OpenClaw PM2 服务。请先安装 PM2 环境。',
            logs: ['[PM2 服务] 阶段 1/1：检查 PM2 运行环境', '[PM2 服务] 未检测到 PM2 CLI，无法继续初始化。']
        };
    }

    if (initial.installed && initial.configPath) {
        logs.push('[PM2 服务] 阶段 1/1：检查 OpenClaw PM2 服务配置');
        logs.push(`[PM2 服务] 已检测到现有 PM2 服务配置：${initial.configPath}`);
        return {
            ...initial,
            ok: true,
            installed: true,
            serviceInstalled: true,
            alreadyInstalled: true,
            logs
        };
    }

    logs.push('[PM2 服务] 阶段 1/5：检查 PM2 运行环境');
    logs.push(`[PM2 服务] Node: ${initial.nodeExe}`);
    logs.push(`[PM2 服务] PM2 CLI: ${initial.pm2Cli}`);

    logs.push('[PM2 服务] 阶段 2/5：解析 OpenClaw 启动入口');
    const entryInfo = resolveOpenClawEntry();
    if (!entryInfo?.path) {
        logs.push('[PM2 服务] 未找到 OpenClaw 入口文件，无法生成 PM2 服务配置。');
        return {
            ...initial,
            ok: false,
            installed: false,
            serviceInstalled: false,
            error: '未找到 OpenClaw 入口文件，无法初始化 PM2 服务。',
            logs
        };
    }
    logs.push(`[PM2 服务] 入口: ${entryInfo.path}`);
    logs.push(`[PM2 服务] 包: ${entryInfo.packageName}`);

    logs.push('[PM2 服务] 阶段 3/5：准备 PM2 服务目录');
    ensureDirectory(openClawHomeDir);
    ensureDirectory(preferredServiceDir);
    ensureDirectory(startupFolderPath);
    logs.push(`[PM2 服务] 服务目录: ${preferredServiceDir}`);

    let shimTargetPath = '';
    if (fs.existsSync(shimAssetPath)) {
        shimTargetPath = path.join(preferredServiceDir, 'windows-hide-child-process.cjs');
        fs.copyFileSync(shimAssetPath, shimTargetPath);
        logs.push(`[PM2 服务] 已写入 Windows 静默补丁: ${shimTargetPath}`);
    }

    logs.push('[PM2 服务] 阶段 4/5：写入 PM2 服务配置');
    const serviceStartupVbsPath = path.join(preferredServiceDir, 'OpenClawSilent.vbs');
    const ecosystemConfigText = buildEcosystemConfigText({
        nodeExe: initial.nodeExe,
        entryPath: entryInfo.path,
        packageName: entryInfo.packageName,
        serviceDir: preferredServiceDir,
        serviceStartupVbsPath,
        shimTargetPath
    });

    fs.writeFileSync(preferredConfigPath, ecosystemConfigText, 'utf8');
    fs.writeFileSync(serviceStartupVbsPath, buildStartupVbsContent(initial.nodeExe, initial.pm2Cli), 'ascii');
    ensureFile(path.join(preferredServiceDir, 'out.log'));
    ensureFile(path.join(preferredServiceDir, 'error.log'));
    logs.push(`[PM2 服务] 已写入: ${preferredConfigPath}`);
    logs.push(`[PM2 服务] 已写入: ${serviceStartupVbsPath}`);

    logs.push('[PM2 服务] 阶段 5/5：验证生成结果');
    const verified = checkPm2ServiceInstalled();
    if (!verified.ok || !verified.installed || !verified.configPath) {
        logs.push(`[PM2 服务] 验证失败，总耗时约 ${Date.now() - startedAt}ms`);
        return {
            ...verified,
            ok: false,
            installed: false,
            serviceInstalled: false,
            error: verified.error || 'OpenClaw PM2 服务配置初始化失败。',
            logs
        };
    }

    logs.push(`[PM2 服务] 初始化完成，耗时约 ${Date.now() - startedAt}ms`);
    logs.push(`[PM2 服务] 配置文件: ${verified.configPath}`);
    return {
        ...verified,
        ok: true,
        installed: true,
        serviceInstalled: true,
        alreadyInstalled: false,
        logs
    };
}

module.exports = {
    checkPm2ServiceInstalled,
    ensurePm2ServiceInstalled
};
