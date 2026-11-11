#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function runSafe(cmd, args, timeoutMs = 8000) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
    error: res.error ? res.error.message : null,
  };
}

function systemExe(relPath, fallback) {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(sysRoot, "System32", relPath);
  return fs.existsSync(candidate) ? candidate : fallback;
}

function findExecutable(name, fallbackPaths = []) {
  const whereRes = runSafe(systemExe("where.exe", "where.exe"), [name], 3000);
  if (whereRes.ok && whereRes.stdout) {
    const first = whereRes.stdout.split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) return first;
  }
  for (const p of fallbackPaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function queryCuaGeminiWindows(cuaBinPath) {
  const res = runSafe(cuaBinPath, ["call", "list_windows", '{"app":"Gemini"}'], 5000);
  if (!res.ok || !res.stdout) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.windows)) return parsed.windows;
    const text = parsed?.content?.find((c) => typeof c.text === "string")?.text;
    if (text) {
      const inner = JSON.parse(text);
      if (Array.isArray(inner)) return inner;
      if (Array.isArray(inner?.windows)) return inner.windows;
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

function checkGeminiDesktopApp(cuaDriver) {
  const localAppData = process.env.LOCALAPPDATA || "";
  const geminiRoot = path.join(localAppData, "Google", "Gemini");
  let installedPath = null;
  let installedVersion = null;

  if (fs.existsSync(geminiRoot)) {
    const entries = fs
      .readdirSync(geminiRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("app-"))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const dirName of entries) {
      const candidate = path.join(geminiRoot, dirName, "Gemini.exe");
      if (fs.existsSync(candidate)) {
        installedPath = candidate;
        installedVersion = dirName.replace(/^app-/, "");
        break;
      }
    }
  }

  const psScript =
    "@(Get-Process | Where-Object { $_.ProcessName -match '^Gemini' } | Select-Object ProcessName, Id, MainWindowHandle, MainWindowTitle, Path) | ConvertTo-Json -Compress";
  const procRes = runSafe(
    systemExe("WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    6000
  );

  let processes = [];
  if (procRes.ok && procRes.stdout) {
    try {
      const parsed = JSON.parse(procRes.stdout);
      processes = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      processes = [];
    }
  }

  const mainWindows = processes.filter(
    (p) =>
      p.ProcessName === "Gemini" &&
      Number(p.MainWindowHandle) !== 0 &&
      !Number.isNaN(Number(p.MainWindowHandle))
  );
  const geminiProcs = processes.filter((p) => p.ProcessName === "Gemini");
  const launcherProcs = processes.filter(
    (p) => p.ProcessName === "GeminiAppLauncher"
  );

  const cuaWindows =
    cuaDriver?.daemonRunning && cuaDriver?.executablePath
      ? queryCuaGeminiWindows(cuaDriver.executablePath)
      : [];

  const openWindows =
    cuaWindows.length > 0
      ? cuaWindows.map((w) => ({
          pid: w.pid ?? null,
          title: w.title || "",
          handle: w.window_id ?? null,
          isOnScreen: w.is_on_screen ?? null,
          minimized: w.minimized ?? null,
        }))
      : mainWindows.map((w) => ({
          pid: w.Id,
          title: w.MainWindowTitle || "",
          handle: w.MainWindowHandle,
        }));

  let status = "not_installed";
  if (openWindows.length > 0) {
    status = "open";
  } else if (geminiProcs.length > 0) {
    status = cuaDriver?.daemonRunning
      ? "background_process_no_window"
      : "running_window_unverified";
  } else if (launcherProcs.length > 0) {
    status = "background_launcher_only";
  } else if (installedPath) {
    status = "closed";
  }

  return {
    status,
    installed: Boolean(installedPath),
    version: installedVersion,
    executablePath: installedPath,
    windowOpen: openWindows.length > 0,
    openWindows,
    geminiProcessCount: geminiProcs.length,
    launcherRunning: launcherProcs.length > 0,
    processes: processes.map((p) => ({
      name: p.ProcessName,
      pid: p.Id,
      hasWindow: Number(p.MainWindowHandle) !== 0,
      title: p.MainWindowTitle || "",
    })),
  };
}

function checkCuaDriver() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const binPath = findExecutable("cua-driver", [
    path.join(localAppData, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe"),
    path.join(localAppData, "Programs", "trycua", "cua-driver-rs", "bin", "cua-driver.exe"),
  ]);

  if (!binPath) {
    return { installed: false, executablePath: null, version: null, daemonRunning: false };
  }

  const verRes = runSafe(binPath, ["--version"], 4000);
  const statusRes = runSafe(binPath, ["status"], 4000);
  const combinedStatus = `${statusRes.stdout} ${statusRes.stderr}`.trim();
  const daemonRunning =
    statusRes.ok && !/not running/i.test(combinedStatus);

  return {
    installed: true,
    executablePath: binPath,
    version: verRes.stdout || verRes.stderr || null,
    daemonRunning,
    statusMessage: combinedStatus || null,
  };
}

function checkAgyCli() {
  const binPath = findExecutable("agy");
  if (!binPath) {
    return {
      installed: false,
      executablePath: null,
      models: [],
      hasArgonModel: false,
    };
  }

  const modelsRes = runSafe(binPath, ["models"], 10000);
  const rawLines = (modelsRes.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const models = rawLines.map((line) => {
    const parts = line.split(/\t+/);
    return {
      id: parts[0]?.trim() || line,
      displayName: parts[1]?.trim() || parts[0]?.trim() || line,
    };
  });

  const hasArgonModel = models.some(
    (m) => m.id === "gemini-4-argon" || /argon/i.test(m.id)
  );

  return {
    installed: true,
    executablePath: binPath,
    modelsQueryOk: modelsRes.ok,
    models,
    hasArgonModel,
    error: modelsRes.ok ? null : modelsRes.stderr || modelsRes.error,
  };
}

async function checkGeminiApi(verifyRemote) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const keySource = process.env.GEMINI_API_KEY
    ? "GEMINI_API_KEY"
    : process.env.GOOGLE_API_KEY
      ? "GOOGLE_API_KEY"
      : null;

  if (!key) {
    return {
      keySet: false,
      keySource: null,
      verified: false,
      keyValid: false,
      argonAccessible: false,
      error: "Neither GEMINI_API_KEY nor GOOGLE_API_KEY is set.",
    };
  }

  if (!verifyRemote) {
    return {
      keySet: true,
      keySource,
      verified: false,
      keyValid: null,
      argonAccessible: null,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon",
      {
        method: "GET",
        headers: { "x-goog-api-key": key },
        signal: controller.signal,
      }
    );

    if (res.ok) {
      const data = await res.json();
      return {
        keySet: true,
        keySource,
        verified: true,
        keyValid: true,
        argonAccessible: true,
        modelName: data.name || "models/gemini-4-argon",
        displayName: data.displayName || "Gemini 4 Argon",
      };
    }

    let errMsg = `HTTP ${res.status}`;
    let errReason = null;
    try {
      const errBody = await res.json();
      errMsg = errBody?.error?.message || errMsg;
      const info = errBody?.error?.details?.find((d) => d.reason);
      errReason = info?.reason || errBody?.error?.status || null;
    } catch {
      // Ignore non-JSON body
    }

    const keyInvalid = res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(`${errReason} ${errMsg}`);
    return {
      keySet: true,
      keySource,
      verified: true,
      keyValid: keyInvalid ? false : null,
      argonAccessible: false,
      httpStatus: res.status,
      errorReason: errReason,
      error: errMsg,
    };
  } catch (err) {
    return {
      keySet: true,
      keySource,
      verified: true,
      keyValid: null,
      argonAccessible: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const checkApi = args.has("--check-api");

  const cuaDriver = checkCuaDriver();
  const desktopApp = checkGeminiDesktopApp(cuaDriver);
  const agy = checkAgyCli();

  const readyBackends = [];
  if (desktopApp.windowOpen && cuaDriver.daemonRunning) {
    readyBackends.push("desktop-cua");
  }
  if (agy.installed && agy.hasArgonModel) {
    readyBackends.push("agy-argon");
  }

  const output = {
    checkedAt: new Date().toISOString(),
    mode: "subscription-first",
    desktopApp,
    cuaDriver,
    agy,
    readyArgonBackends: readyBackends,
  };

  if (checkApi) {
    const geminiApi = await checkGeminiApi(true);
    output.geminiApi = geminiApi;
    if (geminiApi.argonAccessible) {
      readyBackends.push("gemini-api-argon");
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
