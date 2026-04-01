'use strict';

const Module = require('module');
const childProcess = require('node:child_process');
const os = require('node:os');

const PATCH_MARK = Symbol.for('openclaw.windowsHideChildProcessPatched');
const CIAO_PATCH_MARK = Symbol.for('openclaw.ciaoExportsPatched');
const MODULE_PATCH_MARK = Symbol.for('openclaw.ciaoModuleLoadPatched');
const CiaoRequests = new Set([
  '@homebridge/ciao',
  '@homebridge/ciao/lib/index.js',
  '@homebridge/ciao/lib/index'
]);
const VIRTUAL_INTERFACE_RE = /(tailscale|vethernet|hyper-v|virtualbox|vmware|npcap|loopback|teredo|isatap|docker|wsl|bluetooth|bridge|tunnel)/i;

function withWindowsHide(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { windowsHide: true };
  }

  return {
    ...options,
    windowsHide: true
  };
}

function patchSpawnLike(name) {
  const original = childProcess[name];
  childProcess[name] = function patchedSpawnLike(file, args, options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }

    return original.call(this, file, args ?? [], withWindowsHide(options));
  };
}

function patchExec(name) {
  const original = childProcess[name];
  childProcess[name] = function patchedExec(command, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    return original.call(this, command, withWindowsHide(options), callback);
  };
}

function patchExecFile(name) {
  const original = childProcess[name];
  childProcess[name] = function patchedExecFile(file, args, options, callback) {
    if (typeof args === 'function') {
      return original.call(this, file, [], withWindowsHide(undefined), args);
    }

    if (!Array.isArray(args)) {
      callback = typeof options === 'function' ? options : callback;
      options = args;
      args = [];
    } else if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    return original.call(this, file, args ?? [], withWindowsHide(options), callback);
  };
}

function patchExecSync(name) {
  const original = childProcess[name];
  childProcess[name] = function patchedExecSync(command, options) {
    return original.call(this, command, withWindowsHide(options));
  };
}

function patchExecFileSync(name) {
  const original = childProcess[name];
  childProcess[name] = function patchedExecFileSync(file, args, options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }

    return original.call(this, file, args ?? [], withWindowsHide(options));
  };
}

function patchFork() {
  const original = childProcess.fork;
  childProcess.fork = function patchedFork(modulePath, args, options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }

    return original.call(this, modulePath, args ?? [], withWindowsHide(options));
  };
}

function parseCsvEnv(raw) {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
}

function normalizeFamily(entry) {
  if (!entry) return '';
  if (entry.family === 4) return 'IPv4';
  if (entry.family === 6) return 'IPv6';
  return String(entry.family || '');
}

function isPrivateLanIPv4(address) {
  if (typeof address !== 'string') return false;
  const parts = address.trim().split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function isLinkLocalIPv4(address) {
  return typeof address === 'string' && address.trim().startsWith('169.254.');
}

function isLikelyVirtualInterfaceName(name) {
  return VIRTUAL_INTERFACE_RE.test(name || '');
}

function listInterfaceNames(networkInterfaces, predicate) {
  const names = [];
  for (const [name, entries] of Object.entries(networkInterfaces || {})) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    if (predicate(name, entries) && !names.includes(name)) names.push(name);
  }
  return names;
}

function selectBonjourInterfaceNames(options = {}) {
  const env = options.env || process.env;
  const override = parseCsvEnv(env.OPENCLAW_BONJOUR_INTERFACES);
  if (override.length > 0) return override;

  const networkInterfaces = (options.networkInterfaces || os.networkInterfaces)();
  const hasPreferredLanIpv4 = (name, entries) => !isLikelyVirtualInterfaceName(name) && entries.some((entry) => !entry.internal && normalizeFamily(entry) === 'IPv4' && isPrivateLanIPv4(entry.address));
  const hasAnyLanIpv4 = (name, entries) => entries.some((entry) => !entry.internal && normalizeFamily(entry) === 'IPv4' && isPrivateLanIPv4(entry.address));
  const hasAnyExternalIpv4 = (name, entries) => !isLikelyVirtualInterfaceName(name) && entries.some((entry) => !entry.internal && normalizeFamily(entry) === 'IPv4' && !isLinkLocalIPv4(entry.address));

  const preferred = listInterfaceNames(networkInterfaces, hasPreferredLanIpv4);
  if (preferred.length > 0) return preferred;

  const lanFallback = listInterfaceNames(networkInterfaces, hasAnyLanIpv4);
  if (lanFallback.length > 0) return lanFallback;

  return listInterfaceNames(networkInterfaces, hasAnyExternalIpv4);
}

function mergeBonjourOptions(options, patchOptions) {
  if (options && typeof options === 'object' && options.interface) return options;

  const interfaceNames = selectBonjourInterfaceNames(patchOptions);
  if (interfaceNames.length === 0) return options;

  return {
    ...(options && typeof options === 'object' ? options : {}),
    interface: interfaceNames
  };
}

function patchCiaoExports(exportsValue, patchOptions = {}) {
  if (!exportsValue || typeof exportsValue.getResponder !== 'function') return exportsValue;
  if (exportsValue[CIAO_PATCH_MARK]) return exportsValue;

  const originalGetResponder = exportsValue.getResponder;
  const wrappedGetResponder = function patchedGetResponder(options) {
    return originalGetResponder.call(this, mergeBonjourOptions(options, patchOptions));
  };

  exportsValue.getResponder = wrappedGetResponder;
  if (exportsValue.default && typeof exportsValue.default === 'object') {
    exportsValue.default.getResponder = wrappedGetResponder;
  }

  Object.defineProperty(exportsValue, CIAO_PATCH_MARK, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });

  return exportsValue;
}

function patchModuleLoad() {
  if (Module[MODULE_PATCH_MARK]) return;

  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (!CiaoRequests.has(request)) return loaded;
    return patchCiaoExports(loaded);
  };

  Object.defineProperty(Module, MODULE_PATCH_MARK, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

if (process.platform === 'win32' && !childProcess[PATCH_MARK]) {
  patchSpawnLike('spawn');
  patchSpawnLike('spawnSync');
  patchExec('exec');
  patchExecSync('execSync');
  patchExecFile('execFile');
  patchExecFileSync('execFileSync');
  patchFork();
  patchModuleLoad();

  Object.defineProperty(childProcess, PATCH_MARK, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

module.exports = {
  withWindowsHide,
  selectBonjourInterfaceNames,
  patchCiaoExports
};