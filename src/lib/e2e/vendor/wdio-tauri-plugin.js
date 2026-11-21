/*
 * @wdio/tauri-plugin 1.5.1 — dist-js/index.js, unmodified below this comment.
 * https://www.npmjs.com/package/@wdio/tauri-plugin
 * https://github.com/webdriverio/desktop-mobile/tree/main/packages/tauri-plugin
 * npm integrity sha512-EShrPuHMjjxYT3lq8EjB8wlUVeMsIdKPhfH4nIvznUoZtrQ1oYyW5tiJ1EBBBXm2Epm71eXHkFDN8UH098dYQQ==
 * sha256 of the original file 7342c3a9698c827f9be93b53b2572f572c6ffd2ea263fa0b9e325d4b18ac76fd
 *
 * Vendored rather than installed: the package pins its own @tauri-apps/api
 * and pulls @wdio/native-utils (esbuild, tsx), none of which this already
 * bundled file uses; it only imports @tauri-apps/api/core and /event, which
 * resolve to the app's own copy. Loaded ONLY in e2e builds (../wdio-plugin.ts);
 * scripts/check-no-e2e-bits.sh fails a release that contains it.
 * Why: .cowork/journal/2026-11-21-e2e-wdio-plugin.md.
 *
 * MIT License
 *
 * Copyright (c) 2024 WebdriverIO Community
 *
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../native-spy/dist/esm/index.js
var esm_exports = {};
__export(esm_exports, {
  fn: () => fn
});
var globalCallId = 0;
function fn(implementation, options) {
  let mockNameValue = "";
  let defaultReturnValue;
  let defaultResolvedValue;
  let defaultRejectedValue;
  let returnThis = false;
  let implementationFn = implementation;
  let implementationQueue = [];
  const originalFn = options?.original;
  let mockRestored = false;
  const state = {
    calls: [],
    contexts: [],
    results: [],
    invocationCallOrder: [],
    instances: []
  };
  const mockFn = function(...args) {
    let result;
    if (implementationQueue.length > 0) {
      const impl = implementationQueue.shift();
      try {
        const value = impl(...args);
        result = { type: "return", value };
      } catch (error) {
        result = { type: "throw", value: error };
      }
    } else if (defaultRejectedValue !== void 0) {
      result = { type: "throw", value: defaultRejectedValue };
    } else if (implementationFn !== void 0) {
      try {
        const value = implementationFn(...args);
        result = { type: "return", value };
      } catch (error) {
        result = { type: "throw", value: error };
      }
    } else if (defaultResolvedValue !== void 0) {
      result = { type: "return", value: Promise.resolve(defaultResolvedValue) };
    } else if (returnThis) {
      result = { type: "return", value: this };
    } else if (defaultReturnValue !== void 0) {
      result = { type: "return", value: defaultReturnValue };
    } else if (mockRestored && originalFn !== void 0) {
      try {
        const value = originalFn(...args);
        result = { type: "return", value };
      } catch (error) {
        result = { type: "throw", value: error };
      }
    } else {
      result = { type: "return", value: void 0 };
    }
    const context = this === mockFn ? void 0 : this;
    state.calls.push(args);
    state.contexts.push(context);
    state.invocationCallOrder.push(globalCallId++);
    if (result.type === "throw") {
      state.results.push({ type: "throw", value: result.value });
      throw result.value;
    }
    state.results.push({ type: "return", value: result.value });
    return result.value;
  };
  mockFn._isMockFunction = true;
  Object.defineProperty(mockFn, "mock", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: state
  });
  Object.defineProperty(state, "lastCall", {
    get: () => state.calls[state.calls.length - 1],
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(mockFn, "calls", {
    get: () => state.calls,
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(mockFn, "results", {
    get: () => state.results,
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(mockFn, "invocationCallOrder", {
    get: () => state.invocationCallOrder,
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(mockFn, "instances", {
    get: () => state.instances,
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(mockFn, "lastCall", {
    get: () => state.calls[state.calls.length - 1],
    enumerable: true,
    configurable: true
  });
  mockFn.mockName = function(name) {
    mockNameValue = name;
    return this;
  };
  mockFn.getMockName = () => mockNameValue;
  mockFn.mockClear = function() {
    state.calls.length = 0;
    state.contexts.length = 0;
    state.results.length = 0;
    state.invocationCallOrder.length = 0;
    state.instances.length = 0;
    implementationQueue.length = 0;
    return this;
  };
  mockFn.mockReset = function() {
    mockFn.mockClear();
    implementationFn = void 0;
    implementationQueue = [];
    defaultReturnValue = void 0;
    defaultResolvedValue = void 0;
    defaultRejectedValue = void 0;
    returnThis = false;
    mockRestored = false;
    return this;
  };
  mockFn.mockRestore = function() {
    mockFn.mockReset();
    mockRestored = true;
    implementationFn = originalFn;
    return this;
  };
  mockFn.mockImplementation = function(fn2) {
    implementationFn = fn2;
    returnThis = false;
    return this;
  };
  mockFn.mockImplementationOnce = function(fn2) {
    implementationQueue.push(fn2);
    return this;
  };
  mockFn.getMockImplementation = () => implementationFn;
  mockFn.mockReturnValue = function(value) {
    implementationFn = void 0;
    defaultReturnValue = value;
    defaultResolvedValue = void 0;
    defaultRejectedValue = void 0;
    returnThis = false;
    return this;
  };
  mockFn.mockReturnValueOnce = function(value) {
    implementationQueue.push((() => value));
    return this;
  };
  mockFn.mockResolvedValue = function(value) {
    implementationFn = void 0;
    defaultResolvedValue = value;
    defaultReturnValue = void 0;
    defaultRejectedValue = void 0;
    returnThis = false;
    return this;
  };
  mockFn.mockResolvedValueOnce = function(value) {
    implementationQueue.push((async () => value));
    return this;
  };
  mockFn.mockRejectedValue = function(reason) {
    implementationFn = void 0;
    defaultRejectedValue = reason;
    defaultReturnValue = void 0;
    defaultResolvedValue = void 0;
    returnThis = false;
    return this;
  };
  mockFn.mockRejectedValueOnce = function(reason) {
    implementationQueue.push((async () => {
      throw reason;
    }));
    return this;
  };
  mockFn.mockReturnThis = function() {
    returnThis = true;
    defaultReturnValue = void 0;
    defaultResolvedValue = void 0;
    defaultRejectedValue = void 0;
    return this;
  };
  mockFn.withImplementation = function(fn2, callback) {
    const originalImplementation = implementationFn;
    const originalQueue = [...implementationQueue];
    const originalReturnThis = returnThis;
    implementationFn = fn2;
    implementationQueue.length = 0;
    returnThis = false;
    try {
      const result = callback();
      return result;
    } finally {
      implementationFn = originalImplementation;
      implementationQueue.splice(0, implementationQueue.length, ...originalQueue);
      returnThis = originalReturnThis;
    }
  };
  return mockFn;
}

// ../native-utils/dist/esm/script-detect.js
function hasSemicolonOutsideQuotes(s) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  const tmpl = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const topInStr = tmpl.length > 0 && tmpl[tmpl.length - 1].inStr;
    if (c === "\\" && (inSingle || inDouble || topInStr)) {
      i++;
      continue;
    }
    if (topInStr) {
      if (c === "`") {
        tmpl.pop();
      } else if (c === "$" && i + 1 < s.length && s[i + 1] === "{") {
        i++;
        depth++;
        tmpl[tmpl.length - 1].inStr = false;
        tmpl[tmpl.length - 1].exprDepth = depth;
      }
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble)
      continue;
    if (c === "`") {
      tmpl.push({ inStr: true, exprDepth: 0 });
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (tmpl.length > 0 && !tmpl[tmpl.length - 1].inStr && depth === tmpl[tmpl.length - 1].exprDepth - 1) {
        tmpl[tmpl.length - 1].inStr = true;
      }
    } else if (c === ";" && depth === 0) {
      return true;
    }
  }
  return false;
}
function hasTopLevelArrow(s) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  const tmpl = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const topInStr = tmpl.length > 0 && tmpl[tmpl.length - 1].inStr;
    if (c === "\\" && (inSingle || inDouble || topInStr)) {
      i++;
      continue;
    }
    if (topInStr) {
      if (c === "`") {
        tmpl.pop();
      } else if (c === "$" && i + 1 < s.length && s[i + 1] === "{") {
        i++;
        depth++;
        tmpl[tmpl.length - 1].inStr = false;
        tmpl[tmpl.length - 1].exprDepth = depth;
      }
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble)
      continue;
    if (c === "`") {
      tmpl.push({ inStr: true, exprDepth: 0 });
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (tmpl.length > 0 && !tmpl[tmpl.length - 1].inStr && depth === tmpl[tmpl.length - 1].exprDepth - 1) {
        tmpl[tmpl.length - 1].inStr = true;
      }
    } else if (c === "=" && depth === 0 && tmpl.length === 0 && i + 1 < s.length && s[i + 1] === ">") {
      return true;
    }
  }
  return false;
}

// guest-js/index.ts
var _invokeCache = null;
async function getInvoke() {
  if (_invokeCache) {
    return _invokeCache;
  }
  if (typeof window !== "undefined") {
    const originalCore = window.__wdio_original_core__;
    if (originalCore?.invoke) {
      const invoke = originalCore.invoke.bind(originalCore);
      _invokeCache = invoke;
      return invoke;
    }
    if (window.__TAURI__?.core?.invoke) {
      const invoke = window.__TAURI__.core.invoke;
      _invokeCache = invoke;
      return invoke;
    }
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    _invokeCache = invoke;
    return _invokeCache;
  } catch (_error) {
    throw new Error(
      "Tauri API not available. Make sure withGlobalTauri is enabled in tauri.conf.json or @tauri-apps/api is installed."
    );
  }
}
var CleanupRegistry = class {
  constructor() {
    this.timers = /* @__PURE__ */ new Set();
    this.listeners = /* @__PURE__ */ new Set();
  }
  addTimer(id) {
    this.timers.add(id);
  }
  clearTimers() {
    this.timers.forEach((id) => {
      clearTimeout(id);
    });
    this.timers.clear();
  }
  addListener(fn2) {
    this.listeners.add(fn2);
  }
  cleanup() {
    this.clearTimers();
    this.listeners.forEach((fn2) => {
      try {
        fn2();
      } catch {
      }
    });
    this.listeners.clear();
  }
};
var cleanupRegistry = new CleanupRegistry();
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    cleanupRegistry.cleanup();
  });
}
async function execute(script, options, argsJson) {
  if (!window.__TAURI__) {
    throw new Error("window.__TAURI__ is not available. Make sure withGlobalTauri is enabled in tauri.conf.json");
  }
  const trimmed = script.trim();
  const isFunctionLike = trimmed.startsWith("(") && hasTopLevelArrow(trimmed) || /^function[\s(]/.test(trimmed) || /^async[\s(]/.test(trimmed) && (/^async\s+function\b/.test(trimmed) || hasTopLevelArrow(trimmed)) || /^(\w+)\s*=>/.test(trimmed);
  let scriptToSend;
  if (isFunctionLike) {
    scriptToSend = `
    (async () => {
      const __wdio_args = ${argsJson ?? "[]"};

      // Resolve the real invoke: prefer the snapshotted original (set by init() before any
      // Proxy was installed), fall back to window.__TAURI__.core.invoke.
      const __wdio_core_ref = window.__wdio_original_core__;
      let __wdio_invoke_real;
      if (__wdio_core_ref && typeof __wdio_core_ref.invoke === 'function') {
        __wdio_invoke_real = __wdio_core_ref.invoke.bind(__wdio_core_ref);
      } else {
        const startTime = Date.now();
        while (!window.__wdio_original_core__?.invoke && (Date.now() - startTime) < 5000) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const coreRef = window.__wdio_original_core__;
        if (!coreRef?.invoke) throw new Error('Tauri core.invoke not available after 5s timeout');
        __wdio_invoke_real = coreRef.invoke.bind(coreRef);
      }

      const __wdio_invoke = async function(cmd, invokeArgs) {
        const mocks = window.__wdio_mocks__;
        if (mocks && typeof mocks[cmd] === 'function') {
          return mocks[cmd](invokeArgs);
        }
        return __wdio_invoke_real(cmd, invokeArgs);
      };

      // Plain object \u2014 no spreading of window.__TAURI__ to avoid Proxy invariant issues.
      const __wdio_tauri = { core: { invoke: __wdio_invoke } };
      return await (${script})(__wdio_tauri, ...__wdio_args);
    })()
  `.trim();
  } else {
    const hasStatementKeyword = /^(const|let|var|if|for|while|switch|throw|try|do|return)(?=[^\w$]|$)/.test(trimmed);
    const hasStatement = hasStatementKeyword || hasSemicolonOutsideQuotes(trimmed);
    const argsArray = argsJson ?? "[]";
    scriptToSend = hasStatement ? `(async function() { ${script} }).apply(null, ${argsArray})` : `(async function() { return ${script}; }).apply(null, ${argsArray})`;
  }
  const invoke = await getInvoke();
  try {
    const result = await invoke("plugin:wdio|execute", {
      request: {
        script: scriptToSend,
        args: [],
        window_label: options?.windowLabel
      }
    });
    return result;
  } catch (error) {
    throw new Error(`Failed to execute script: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function getConsoleForwardingCode() {
  return `
    // Setup console forwarding to Tauri log plugin
    (function() {
      if (typeof window === 'undefined' || !window.__TAURI__?.log) {
        return;
      }

      // Store original methods
      const originalConsole = {
        log: console.log.bind(console),
        debug: console.debug.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
      };

      // Helper to forward to Tauri log plugin
      // The log plugin outputs to stdout with target="frontend"
      function forward(level, args) {
        const message = Array.from(args).map(arg =>
          typeof arg === 'string' ? arg : JSON.stringify(arg)
        ).join(' ');

        // Call original console method
        originalConsole[level === 'trace' ? 'log' : level](message);

        // Forward to Tauri log plugin
        if (window.__TAURI__.log[level]) {
          window.__TAURI__.log[level](message).catch(() => {});
        }
      }

      // Wrap console methods using Object.defineProperty (works on WebKit)
      try {
        Object.defineProperty(console, 'log', {
          value: function() { forward('trace', arguments); },
          writable: true,
          configurable: true
        });
        Object.defineProperty(console, 'debug', {
          value: function() { forward('debug', arguments); },
          writable: true,
          configurable: true
        });
        Object.defineProperty(console, 'info', {
          value: function() { forward('info', arguments); },
          writable: true,
          configurable: true
        });
        Object.defineProperty(console, 'warn', {
          value: function() { forward('warn', arguments); },
          writable: true,
          configurable: true
        });
        Object.defineProperty(console, 'error', {
          value: function() { forward('error', arguments); },
          writable: true,
          configurable: true
        });
      } catch (err) {
        // If Object.defineProperty fails, console forwarding won't work
      }
    })();
  `;
}
function setupConsoleForwarding() {
  if (typeof window === "undefined") {
    return;
  }
  async function forwardToTauri(level, message) {
    try {
      if (window.__TAURI__?.log?.[level]) {
        await window.__TAURI__.log[level](message);
        return;
      }
      if (window.__TAURI__?.core?.invoke) {
        await window.__TAURI__.core.invoke("plugin:wdio|log_frontend", {
          message,
          level
        });
      }
    } catch {
    }
  }
  const originalConsole = {
    log: console.log,
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
    trace: console.trace
  };
  try {
    Object.defineProperty(console, "log", {
      value: (...args) => {
        const message = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
        originalConsole.log(...args);
        forwardToTauri("trace", message).catch(() => {
        });
      },
      writable: true,
      configurable: true
    });
    Object.defineProperty(console, "debug", {
      value: (...args) => {
        const message = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
        originalConsole.debug(...args);
        forwardToTauri("debug", message).catch(() => {
        });
      },
      writable: true,
      configurable: true
    });
    Object.defineProperty(console, "info", {
      value: (...args) => {
        const message = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
        originalConsole.info(...args);
        forwardToTauri("info", message).catch(() => {
        });
      },
      writable: true,
      configurable: true
    });
    Object.defineProperty(console, "warn", {
      value: (...args) => {
        const message = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
        originalConsole.warn(...args);
        forwardToTauri("warn", message).catch(() => {
        });
      },
      writable: true,
      configurable: true
    });
    Object.defineProperty(console, "error", {
      value: (...args) => {
        const message = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
        originalConsole.error(...args);
        forwardToTauri("error", message).catch(() => {
        });
      },
      writable: true,
      configurable: true
    });
    Object.defineProperty(console, "trace", {
      value: (...args) => {
        const message = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
        originalConsole.trace(...args);
        forwardToTauri("trace", message).catch(() => {
        });
      },
      writable: true,
      configurable: true
    });
  } catch (_error) {
  }
}
function setupInvokeInterception() {
  if (typeof window === "undefined") {
    console.warn("[WDIO Tauri Plugin] Cannot setup invoke interception - window not available");
    return;
  }
  let attempts = 0;
  const maxAttempts = 50;
  const retryInterval = 100;
  const trySetup = () => {
    attempts++;
    const core = window.__TAURI__?.core;
    if (!core || typeof core !== "object") {
      if (attempts < maxAttempts) {
        console.log(`[WDIO Tauri Plugin] Waiting for window.__TAURI__.core (attempt ${attempts}/${maxAttempts})`);
        const timerId = window.setTimeout(trySetup, retryInterval);
        cleanupRegistry.addTimer(timerId);
        return;
      } else {
        console.warn("[WDIO Tauri Plugin] Timeout waiting for window.__TAURI__.core - invoke interception not set up");
        return;
      }
    }
    if (core._wdioInvokeInterceptor) {
      console.log("[WDIO Tauri Plugin] Invoke interception already set up");
      return;
    }
    if (!window.__wdio_original_tauri__) {
      window.__wdio_original_tauri__ = window.__TAURI__;
    }
    if (!window.__wdio_original_core__) {
      window.__wdio_original_core__ = core;
    }
    let _baseInvoke = typeof core.invoke === "function" ? core.invoke.bind(core) : null;
    const wrappedInvoke = async (cmd, args) => {
      const mockFn = window.__wdio_mocks__?.[cmd];
      if (mockFn && typeof mockFn === "function") {
        console.log(`[WDIO Tauri Plugin] Intercepted invoke for '${cmd}' - using mock`);
        try {
          const result = await mockFn(args);
          return result;
        } catch (error) {
          console.error(`[WDIO Tauri Plugin] Mock error for '${cmd}':`, error);
          throw error;
        }
      }
      if (_baseInvoke) {
        return _baseInvoke(cmd, args);
      }
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return invoke(cmd, args);
      } catch (_error) {
        throw new Error(`Tauri API not available for command: ${cmd}`);
      }
    };
    try {
      Object.defineProperty(core, "invoke", {
        get() {
          return wrappedInvoke;
        },
        set(newInvoke) {
          _baseInvoke = typeof newInvoke === "function" ? newInvoke : null;
        },
        configurable: true,
        enumerable: true
      });
      core._wdioInvokeInterceptor = true;
      console.log("[WDIO Tauri Plugin] \u2705 Invoke interception setup complete (defineProperty)");
      return;
    } catch (_defineError) {
      console.warn(
        "[WDIO Tauri Plugin] \u26A0\uFE0F Invoke interception via defineProperty failed; mock routing via window.__wdio_mocks__ remains active"
      );
    }
  };
  trySetup();
}
function setupBackendLogListener() {
  if (typeof window === "undefined") {
    console.info("[WDIO][Frontend] setupBackendLogListener: window is undefined, skipping");
    return;
  }
  console.info("[WDIO][Frontend] Installing backend-log listener");
  const maxAttempts = 100;
  const retryInterval = 50;
  let attempts = 0;
  let removeListenerRef = null;
  const trySetup = () => {
    attempts++;
    if (attempts % 10 === 1) {
      console.info(`[WDIO][Frontend] Waiting for Tauri (attempt ${attempts}/${maxAttempts})`);
    }
    if (attempts >= maxAttempts) {
      console.warn("[WDIO][Frontend] Timeout waiting for Tauri - backend log listener not set up");
      return;
    }
    if (typeof window.__TAURI__ === "undefined" || typeof window.__TAURI__.event === "undefined") {
      const timerId = window.setTimeout(trySetup, retryInterval);
      cleanupRegistry.addTimer(timerId);
      return;
    }
    console.info("[WDIO][Frontend] Tauri ready - setting up backend-log listener");
    const setupListener = async () => {
      try {
        console.info("[WDIO][Frontend] Importing @tauri-apps/api/event");
        const { listen } = await import("@tauri-apps/api/event");
        console.info("[WDIO][Frontend] Event module imported successfully");
        const removeListener = await listen("backend-log", (event) => {
          console.info("[WDIO][Frontend] backend-log received:", event.payload);
          const logMessage = event.payload;
          console.info(logMessage);
        });
        removeListenerRef = removeListener;
        cleanupRegistry.addListener(removeListener);
        console.info("[WDIO][Frontend] Backend log listener registered successfully");
        if (!window.wdioTauri) {
          window.wdioTauri = {};
        }
        const wdioTauri = window.wdioTauri;
        if (!wdioTauri) {
          return;
        }
        wdioTauri.cleanupBackendLogListener = () => {
          if (removeListenerRef) {
            removeListenerRef();
            removeListenerRef = null;
          }
          console.log("[WDIO Tauri Plugin] Backend log listener cleaned up");
        };
      } catch (error) {
        console.log(`[WDIO Tauri Plugin] Failed to setup backend log listener: ${error}`);
      }
    };
    setupListener();
  };
  trySetup();
}
async function init() {
  if (isInitialized) {
    console.log("[WDIO Tauri Plugin] Already initialized, skipping");
    return;
  }
  const messages = [];
  messages.push("[WDIO Tauri Plugin] Initializing...");
  messages.push(`[WDIO Tauri Plugin] typeof window: ${typeof window}`);
  if (typeof window === "undefined") {
    messages.push("[WDIO Tauri Plugin] Window is undefined, skipping initialization");
    for (const msg of messages) {
      console.log(msg);
    }
    return;
  }
  messages.push(`[WDIO Tauri Plugin] window.__TAURI__ available: ${typeof window.__TAURI__ !== "undefined"}`);
  messages.push(
    `[WDIO Tauri Plugin] window.__TAURI__?.core?.invoke available: ${typeof window.__TAURI__?.core?.invoke !== "undefined"}`
  );
  messages.push(`[WDIO Tauri Plugin] window.__TAURI__?.log available: ${typeof window.__TAURI__?.log !== "undefined"}`);
  if (!window.wdioTauri) {
    window.wdioTauri = {};
  }
  const wdioTauriObj = window.wdioTauri;
  wdioTauriObj.execute = execute;
  wdioTauriObj.waitForInit = waitForInit;
  wdioTauriObj.cleanupLogListeners = () => cleanupRegistry.cleanup();
  wdioTauriObj.cleanupInvokeInterception = () => {
    cleanupRegistry.clearTimers();
  };
  wdioTauriObj.cleanupAll = () => {
    wdioTauriObj.cleanupBackendLogListener?.();
    wdioTauriObj.cleanupFrontendLogListener?.();
    wdioTauriObj.cleanupInvokeInterception?.();
    cleanupRegistry.cleanup();
  };
  messages.push("[WDIO Tauri Plugin] window.wdioTauri set successfully");
  messages.push(
    `[WDIO Tauri Plugin] window.wdioTauri.execute: ${window.wdioTauri?.execute ? "function" : "undefined"}`
  );
  for (const msg of messages) {
    console.log(msg);
  }
  console.log("[WDIO Tauri Plugin] Setting up manual console forwarding for WebDriver compatibility");
  setupConsoleForwarding();
  console.log("[WDIO Tauri Plugin] \u2705 Console forwarding initialized");
  console.log("[WDIO Tauri Plugin] Setting up backend log event listener...");
  setupBackendLogListener();
  console.log("[WDIO Tauri Plugin] \u2705 Backend log listener initialized");
  window.__wdio_spy__ = esm_exports;
  if (window.__TAURI__?.core) {
    window.__wdio_original_tauri__ = window.__TAURI__;
    window.__wdio_original_core__ = window.__TAURI__.core;
  }
  console.log("[WDIO Tauri Plugin] Setting up invoke interception for mocking...");
  setupInvokeInterception();
  for (const msg of messages) {
    console.log(msg);
  }
  console.info("[WDIO Tauri Plugin] TEST: This is a test INFO log after setupConsoleForwarding()");
  console.warn("[WDIO Tauri Plugin] TEST: This is a test WARN log after setupConsoleForwarding()");
  isInitialized = true;
}
var initPromise = null;
var isInitialized = false;
if (typeof window !== "undefined") {
  if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (!isInitialized) {
        initPromise = init();
      }
    });
  } else {
    if (!isInitialized) {
      initPromise = init();
    }
  }
}
async function waitForInit() {
  if (initPromise) {
    await initPromise;
  }
}
export {
  cleanupRegistry,
  execute,
  getConsoleForwardingCode,
  init,
  waitForInit
};
