#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  "coverage",
]);

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".pdb", ".obj",
  ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".wav", ".avi",
  ".db", ".sqlite", ".sqlite3", ".lock",
]);

const SECRET_FILE_RE = /(^\.env($|\.)|^\.(npmrc|netrc|pypirc|htpasswd|git-credentials)$|\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$|^id_(rsa|ed25519|ecdsa|dsa)$|^credentials\.json$|.*(service[-_]?account|client[-_]?secret).*\.json$)/i;

function parseArgs(argv) {
  const opts = {
    prompt: "",
    promptFile: null,
    targets: [],
    thinking: "high",
    backend: "auto",
    allowAgyFallbackModel: null,
    maxContextBytes: 400_000,
    packOnly: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--prompt":
      case "-p":
        opts.prompt = argv[++i] ?? "";
        break;
      case "--prompt-file":
        opts.promptFile = argv[++i] ?? "";
        break;
      case "--target":
      case "-t":
        opts.targets.push(argv[++i] ?? "");
        break;
      case "--thinking":
        opts.thinking = (argv[++i] ?? "high").toLowerCase();
        break;
      case "--backend":
        opts.backend = (argv[++i] ?? "auto").toLowerCase();
        break;
      case "--allow-agy-fallback-model":
        opts.allowAgyFallbackModel = argv[++i] ?? "";
        break;
      case "--max-context-bytes":
        opts.maxContextBytes = Number(argv[++i] ?? 400_000);
        break;
      case "--pack-only":
        opts.packOnly = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.promptFile) {
    const resolvedPromptFile = path.resolve(opts.promptFile);
    if (SECRET_FILE_RE.test(path.basename(resolvedPromptFile))) {
      throw new Error(`Refusing to read potential secret file via --prompt-file: ${resolvedPromptFile}`);
    }
    opts.prompt = fs.readFileSync(resolvedPromptFile, "utf8");
  }
  if (!Number.isFinite(opts.maxContextBytes) || opts.maxContextBytes <= 0) {
    throw new Error(`Invalid --max-context-bytes "${opts.maxContextBytes}". Expected a positive number.`);
  }
  if (!["low", "medium", "high"].includes(opts.thinking)) {
    throw new Error(`Invalid --thinking "${opts.thinking}". Expected low, medium, or high.`);
  }
  if (!["auto", "agy", "api"].includes(opts.backend)) {
    throw new Error(`Invalid --backend "${opts.backend}". Expected auto, agy, or api.`);
  }
  if (!opts.prompt.trim() && !opts.packOnly) {
    throw new Error("A prompt is required (--prompt or --prompt-file).");
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node delegate_argon.mjs --prompt "<task>" [options]

Options:
  --prompt, -p <text>                 Task instructions to delegate
  --prompt-file <path>                Read task instructions from file
  --target, -t <path>                 File or directory to include (repeatable)
  --thinking <low|medium|high>        Argon thinking level (default: high)
  --backend <auto|agy|api>            Routing backend (default: auto)
  --allow-agy-fallback-model <model>  Explicitly allow another agy model if Argon is absent
  --max-context-bytes <n>             Max packed source bytes (default: 400000)
  --pack-only                         Output packed context summary only
  --dry-run                           Show planned backend/payload without executing
  --json                              Emit structured JSON output`);
}

function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function collectTargetFiles(targets, maxBytes) {
  const included = [];
  const skipped = [];
  let totalBytes = 0;

  function walk(absPath, rootLabel) {
    let stat;
    try {
      stat = fs.lstatSync(absPath);
    } catch (err) {
      skipped.push({ path: absPath, reason: err.message });
      return;
    }

    if (stat.isSymbolicLink()) {
      skipped.push({ path: absPath, reason: "symlink_skipped" });
      return;
    }

    const base = path.basename(absPath);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(base)) {
        skipped.push({ path: absPath, reason: "skipped_directory" });
        return;
      }
      const entries = fs.readdirSync(absPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        walk(path.join(absPath, entry.name), rootLabel);
      }
      return;
    }

    if (!stat.isFile()) return;

    if (SECRET_FILE_RE.test(base)) {
      skipped.push({ path: absPath, reason: "secret_file_excluded" });
      return;
    }
    const ext = path.extname(base).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) {
      skipped.push({ path: absPath, reason: "binary_or_ignored_extension" });
      return;
    }

    const buf = fs.readFileSync(absPath);
    if (isProbablyBinary(buf)) {
      skipped.push({ path: absPath, reason: "binary_content" });
      return;
    }

    if (totalBytes + buf.length > maxBytes) {
      skipped.push({ path: absPath, reason: "max_context_bytes_exceeded" });
      return;
    }

    totalBytes += buf.length;
    const rel = path.relative(path.dirname(rootLabel), absPath) || base;
    included.push({
      path: absPath,
      relativePath: rel.replace(/\\/g, "/"),
      bytes: buf.length,
      content: buf.toString("utf8"),
    });
  }

  for (const rawTarget of targets) {
    if (!rawTarget) continue;
    const resolved = path.resolve(rawTarget);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Target path does not exist: ${rawTarget} (${resolved})`);
    }
    walk(resolved, resolved);
  }

  return { included, skipped, totalBytes };
}

function formatPackedPrompt(prompt, packed) {
  if (packed.included.length === 0) return prompt;
  const sections = packed.included.map(
    (f) => `<file path="${f.relativePath}">\n${f.content}\n</file>`
  );
  return `${prompt}\n\n<workspace_files>\n${sections.join("\n\n")}\n</workspace_files>`;
}

function getAgyModels() {
  const res = spawnSync("agy", ["models"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    return { available: false, models: [], error: res.error?.message || res.stderr || "agy failed" };
  }
  const models = (res.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t+/)[0].trim());
  return { available: true, models, error: null };
}

function buildAgyPrompt(prompt, packed, baseDir) {
  if (!packed.included.length) return prompt;
  const maxListed = 80;
  const listed = packed.included.slice(0, maxListed).map((f) => {
    const rel = baseDir ? path.relative(baseDir, f.path).replace(/\\/g, "/") : f.relativePath;
    return `- ${rel}`;
  });
  const extra =
    packed.included.length > maxListed
      ? `\n...and ${packed.included.length - maxListed} more non-secret files under the workspace.`
      : "";
  return `${prompt}\n\nUse your file reading tools (not shell commands) to inspect these target files:\n${listed.join("\n")}${extra}`;
}

function runAgy(model, opts, packed) {
  const targetDirs = [];
  const seenDirs = new Set();
  for (const t of opts.targets) {
    const resolved = path.resolve(t);
    const dir = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? path.dirname(resolved) : resolved;
    if (!seenDirs.has(dir)) {
      seenDirs.add(dir);
      targetDirs.push(dir);
    }
  }

  const agyCwd = targetDirs[0] || process.cwd();
  const agyPrompt = buildAgyPrompt(opts.prompt, packed, agyCwd);
  const args = [
    "-p",
    agyPrompt,
    "--model",
    model,
  ];
  const suffixEffortMatch = model.match(/-(low|medium|high)$/i);
  if (!suffixEffortMatch) {
    args.push("--effort", opts.thinking);
  }
  args.push("--mode", "plan", "--output-format", "json");
  for (const dir of targetDirs) {
    args.push("--add-dir", dir);
  }

  const res = spawnSync("agy", args, {
    cwd: agyCwd,
    encoding: "utf8",
    timeout: 300_000,
    windowsHide: true,
  });

  if (res.error || res.status !== 0) {
    throw new Error(`agy failed (${res.status}): ${res.error?.message || res.stderr || res.stdout}`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }

  const responseText =
    typeof parsed?.result === "string" && parsed.result.length > 0
      ? parsed.result
      : typeof parsed?.response === "string"
        ? parsed.response
        : res.stdout.trim();

  if (!responseText && parsed?.denied_actions?.length) {
    const denied = parsed.denied_actions.map((d) => d.display_name || d.action).join(", ");
    throw new Error(`agy returned an empty response because actions were denied in print mode: ${denied}`);
  }

  const effectiveThinking = suffixEffortMatch ? suffixEffortMatch[1].toLowerCase() : opts.thinking;

  return {
    backend: "agy",
    model,
    thinkingLevel: effectiveThinking,
    response: responseText,
    raw: parsed,
  };
}

async function runGeminiApi(opts, packed) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) {
    throw new Error("Gemini API fallback unavailable: GEMINI_API_KEY / GOOGLE_API_KEY is not set.");
  }

  const fullText = formatPackedPrompt(opts.prompt, packed);
  const body = {
    contents: [{ parts: [{ text: fullText }] }],
    generationConfig: {
      maxOutputTokens: 65536,
      thinkingConfig: {
        thinkingLevel: opts.thinking.toUpperCase(),
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  let res;
  let data = null;
  try {
    res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
    data = await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini API request failed: ${msg}`);
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("\n");

  return {
    backend: "gemini-api",
    model: "gemini-4-argon",
    thinkingLevel: opts.thinking,
    usageMetadata: data?.usageMetadata || null,
    response: text,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const packed = collectTargetFiles(opts.targets, opts.maxContextBytes);

  if (opts.packOnly) {
    const text = formatPackedPrompt(opts.prompt || "[No prompt provided]", packed);
    const result = {
      mode: "pack-only",
      includedFiles: packed.included.map((f) => ({ path: f.relativePath, bytes: f.bytes })),
      skippedFiles: packed.skipped,
      totalBytes: packed.totalBytes,
      packedPrompt: text,
    };
    console.log(opts.json ? JSON.stringify(result, null, 2) : text);
    return;
  }

  const agyInfo = opts.backend === "api" ? { available: false, models: [] } : getAgyModels();
  const hasArgonInAgy = agyInfo.available && agyInfo.models.includes("gemini-4-argon");

  let selectedBackend = opts.backend;
  let selectedModel = "gemini-4-argon";

  if (opts.backend === "auto") {
    if (hasArgonInAgy) {
      selectedBackend = "agy";
    } else if (opts.allowAgyFallbackModel) {
      if (!agyInfo.models.includes(opts.allowAgyFallbackModel)) {
        throw new Error(
          `Requested fallback model "${opts.allowAgyFallbackModel}" not in agy models: ${agyInfo.models.join(", ")}`
        );
      }
      selectedBackend = "agy";
      selectedModel = opts.allowAgyFallbackModel;
    } else {
      throw new Error(
        `gemini-4-argon is not listed in agy models (${agyInfo.models.join(", ") || "none"}). Use the Gemini desktop app (Tier 1 via cua-driver) with your subscription, or pass --allow-agy-fallback-model <model>.`
      );
    }
  } else if (opts.backend === "agy") {
    if (hasArgonInAgy) {
      selectedModel = "gemini-4-argon";
    } else if (opts.allowAgyFallbackModel) {
      if (!agyInfo.models.includes(opts.allowAgyFallbackModel)) {
        throw new Error(
          `Requested fallback model "${opts.allowAgyFallbackModel}" not in agy models: ${agyInfo.models.join(", ")}`
        );
      }
      selectedModel = opts.allowAgyFallbackModel;
    } else {
      throw new Error(
        `gemini-4-argon is not listed in agy models (${agyInfo.models.join(", ") || "none"}). Use --backend api or explicitly pass --allow-agy-fallback-model <model>.`
      );
    }
  }

  if (opts.dryRun) {
    const preview = {
      dryRun: true,
      selectedBackend,
      selectedModel,
      thinkingLevel: opts.thinking,
      agyAvailable: agyInfo.available,
      agyModels: agyInfo.models,
      includedFiles: packed.included.map((f) => ({ path: f.relativePath, bytes: f.bytes })),
      skippedFiles: packed.skipped,
      totalContextBytes: packed.totalBytes,
    };
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const result =
    selectedBackend === "agy"
      ? runAgy(selectedModel, opts, packed)
      : await runGeminiApi(opts, packed);

  const finalOut = {
    ...result,
    includedFiles: packed.included.map((f) => f.relativePath),
    skippedFiles: packed.skipped,
  };

  if (opts.json) {
    console.log(JSON.stringify(finalOut, null, 2));
  } else {
    console.log(`[backend=${finalOut.backend} model=${finalOut.model} thinking=${finalOut.thinkingLevel}]\n`);
    console.log(finalOut.response);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
