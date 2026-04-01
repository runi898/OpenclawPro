const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function collectStdoutLines(result) {
    const text = String(result?.stdout || '').trim();
    if (!text) return [];
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function getSafeEnv(baseEnv = process.env) {
    const env = { ...baseEnv };
    const npmGlobalBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
    if (env.PATH && !env.PATH.includes(npmGlobalBin)) {
        env.PATH = `${npmGlobalBin};${env.PATH}`;
    } else if (!env.PATH) {
        env.PATH = npmGlobalBin;
    }
    if (env.Path && !env.Path.includes(npmGlobalBin)) {
        env.Path = `${npmGlobalBin};${env.Path}`;
    } else if (!env.Path) {
        env.Path = npmGlobalBin;
    }
    return env;
}

function runHiddenSync(command, args = [], options = {}) {
    return spawnSync(command, args, {
        windowsHide: true,
        encoding: 'utf8',
        ...options
    });
}

function isNodeExecutable(candidate) {
    const value = String(candidate || '').trim();
    if (!value) return false;
    return path.basename(value).toLowerCase() === 'node.exe';
}

function resolveNodeExecutableSync() {
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
        const value = String(candidate || '').trim();
        if (!value || seen.has(value)) return;
        seen.add(value);
        candidates.push(value);
    };

    try {
        collectStdoutLines(runHiddenSync('where', ['node'], { env: getSafeEnv() })).forEach(pushCandidate);
    } catch (_) {}

    pushCandidate(path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'));
    pushCandidate(path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs', 'node.exe'));
    if (isNodeExecutable(process.execPath)) {
        pushCandidate(process.execPath);
    }

    return candidates.find((candidate) => isNodeExecutable(candidate) && fs.existsSync(candidate)) || '';
}

function resolveNpmCliSync(nodeExe) {
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
        const value = String(candidate || '').trim();
        if (!value || seen.has(value)) return;
        seen.add(value);
        candidates.push(value);
    };

    const nodeDir = nodeExe ? path.dirname(nodeExe) : '';
    if (nodeDir) {
        pushCandidate(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    if (process.env.ProgramFiles) {
        pushCandidate(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    if (process.env['ProgramFiles(x86)']) {
        pushCandidate(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }

    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function runNpmCliSync(nodeExe, npmCli, args = [], options = {}) {
    return runHiddenSync(nodeExe, [npmCli, ...args], {
        env: getSafeEnv(options.env),
        ...options
    });
}

function collectNpmModuleRootsSync(nodeExe, npmCli) {
    const roots = [];
    const seen = new Set();
    const pushRoot = (candidate) => {
        const value = String(candidate || '').trim();
        if (!value || seen.has(value) || !fs.existsSync(value)) return;
        seen.add(value);
        roots.push(value);
    };

    if (nodeExe && npmCli) {
        try {
            const npmRoot = collectStdoutLines(runNpmCliSync(nodeExe, npmCli, ['root', '-g']))[0];
            pushRoot(npmRoot);
        } catch (_) {}

        try {
            const npmPrefix = collectStdoutLines(runNpmCliSync(nodeExe, npmCli, ['config', 'get', 'prefix']))[0];
            if (npmPrefix) {
                pushRoot(path.join(npmPrefix, 'node_modules'));
            }
        } catch (_) {}
    }

    if (process.env.APPDATA) {
        pushRoot(path.join(process.env.APPDATA, 'npm', 'node_modules'));
    }
    if (process.env.ProgramFiles) {
        pushRoot(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'));
    }
    if (process.env['ProgramFiles(x86)']) {
        pushRoot(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node_modules'));
    }

    return roots;
}

function resolvePm2CliFromRoots(roots = []) {
    for (const root of roots) {
        const candidate = path.join(root, 'pm2', 'bin', 'pm2');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return '';
}

function checkPm2RuntimeInstalled() {
    const nodeExe = resolveNodeExecutableSync();
    if (!nodeExe) {
        return {
            ok: false,
            installed: false,
            canAutoInstall: false,
            nodeExe: '',
            npmCli: '',
            pm2Cli: '',
            error: '未找到系统 Node.js（node.exe），当前无法自动安装 PM2。请先安装完整 Node.js/npm。',
            logs: []
        };
    }

    const npmCli = resolveNpmCliSync(nodeExe);
    const roots = collectNpmModuleRootsSync(nodeExe, npmCli);
    const pm2Cli = resolvePm2CliFromRoots(roots);
    return {
        ok: true,
        installed: Boolean(pm2Cli),
        canAutoInstall: Boolean(npmCli),
        nodeExe,
        npmCli,
        pm2Cli,
        error: pm2Cli
            ? ''
            : (npmCli ? '当前环境未检测到 PM2 CLI。' : '已检测到系统 Node.js，但缺少 npm-cli.js，无法自动安装 PM2。'),
        logs: []
    };
}

function ensurePm2RuntimeInstalled() {
    const initial = checkPm2RuntimeInstalled();
    const logs = [];
    const startedAt = Date.now();
    const userGlobalPrefix = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm');

    if (!initial.ok) {
        return { ...initial, logs };
    }

    if (initial.installed) {
        logs.push('[PM2 环境] 阶段 1/1：检查运行环境');
        logs.push(`[PM2 环境] 已检测到 PM2，无需安装。Node: ${initial.nodeExe}`);
        logs.push(`[PM2 环境] PM2 CLI: ${initial.pm2Cli}`);
        return {
            ok: true,
            installed: true,
            alreadyInstalled: true,
            canAutoInstall: true,
            nodeExe: initial.nodeExe,
            npmCli: initial.npmCli,
            pm2Cli: initial.pm2Cli,
            error: '',
            logs
        };
    }

    if (!initial.npmCli) {
        return {
            ok: false,
            installed: false,
            alreadyInstalled: false,
            canAutoInstall: false,
            nodeExe: initial.nodeExe,
            npmCli: '',
            pm2Cli: '',
            error: '未找到 npm-cli.js，无法自动安装 PM2。请先确认 Node.js/npm 安装完整。',
            logs: [
                '[PM2 环境] 阶段 1/1：检查运行环境',
                `[PM2 环境] Node: ${initial.nodeExe}`,
                '[PM2 环境] 未找到 npm-cli.js，无法继续自动安装。'
            ]
        };
    }

    logs.push('[PM2 环境] 阶段 1/4：检查运行环境');
    logs.push(`[PM2 环境] Node: ${initial.nodeExe}`);
    logs.push(`[PM2 环境] npm CLI: ${initial.npmCli}`);
    logs.push(`[PM2 环境] 目标安装前缀: ${userGlobalPrefix}`);
    logs.push('[PM2 环境] 未检测到 PM2，开始准备安装 pm2 与 pm2-windows-startup。');

    logs.push('[PM2 环境] 阶段 2/4：配置 npm 镜像');
    const registryResult = runNpmCliSync(initial.nodeExe, initial.npmCli, ['config', 'set', 'registry', 'https://registry.npmmirror.com/'], {
        timeout: 120000
    });
    const registryOutput = `${registryResult.stdout || ''}\n${registryResult.stderr || ''}`.trim();
    if (registryOutput) {
        logs.push(registryOutput);
    }
    logs.push(`[PM2 环境] npm 镜像配置完成，退出码: ${registryResult.status ?? 'unknown'}`);

    logs.push('[PM2 环境] 阶段 3/4：安装 PM2 运行环境');
    const installResult = runNpmCliSync(initial.nodeExe, initial.npmCli, ['install', 'pm2', 'pm2-windows-startup', '-g', '--prefix', userGlobalPrefix], {
        timeout: 600000
    });
    const installOutput = `${installResult.stdout || ''}\n${installResult.stderr || ''}`.trim();
    if (installOutput) {
        logs.push(installOutput);
    }

    logs.push('[PM2 环境] 阶段 4/4：验证安装结果');
    const verified = checkPm2RuntimeInstalled();
    if (!verified.ok || !verified.installed) {
        logs.push(`[PM2 环境] 安装验证失败，总耗时约 ${Date.now() - startedAt}ms`);
        return {
            ok: false,
            installed: false,
            alreadyInstalled: false,
            canAutoInstall: false,
            nodeExe: verified.nodeExe || initial.nodeExe,
            npmCli: verified.npmCli || initial.npmCli,
            pm2Cli: '',
            error: verified.error || 'PM2 安装后仍未检测到 CLI 入口。',
            logs
        };
    }

    logs.push(`[PM2 环境] 安装完成，耗时约 ${Date.now() - startedAt}ms`);
    logs.push(`[PM2 环境] PM2 CLI: ${verified.pm2Cli}`);
    return {
        ok: true,
        installed: true,
        alreadyInstalled: false,
        canAutoInstall: true,
        nodeExe: verified.nodeExe,
        npmCli: verified.npmCli,
        pm2Cli: verified.pm2Cli,
        error: '',
        logs
    };
}

module.exports = {
    checkPm2RuntimeInstalled,
    ensurePm2RuntimeInstalled
};
