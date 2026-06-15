import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";

const MODEL_ALIASES = new Map([
  ["pro", "gemini-2.5-pro"],
  ["flash", "gemini-2.5-flash"]
]);

const DEFAULT_REVIEW_DIRECTIVE =
  "Produce the review now. Follow the structured output contract above and return only the JSON object it specifies.";
const DEFAULT_STOP_GATE_DIRECTIVE =
  "Produce your verdict now. Follow the compact output contract above; the first line must be ALLOW: or BLOCK:.";

const STDERR_NOISE_PATTERNS = [
  /^\s*$/,
  /not running in a trusted directory/i,
  /^\[USER\] Policy file warning/i,
  /Unrecognized tool name/i,
  /^Rule #\d+:/i,
  /Duplicate agent name/i,
  /MCP issues detected/i,
  /Failed to compile MCP tool output schema/i,
  /Skip(ping)? output validation/i,
  /Skill conflict detected/i,
  /^Hook system message:/i,
  /Ready\s+[—-]\s+\d+ sources active/i,
  /Attempt \d+ failed with status \d+\. Retrying/i,
  /No capacity available for model/i,
  /Gaxios(Error)?/i,
  /_load_nvm/i,
  /command not found/i,
  /^\s*"(error|code|message|errors|domain|reason)"\s*:/i,
  /^\s*[{}\[\],]+\s*$/,
  /backoff/i
];

export function cleanGeminiStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .filter((line) => line.trim() && !STDERR_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n");
}

export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

export function getGeminiAvailability(cwd) {
  const versionStatus = binaryAvailable("gemini", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }
  return {
    available: true,
    detail: versionStatus.detail
  };
}

function fileExists(candidate) {
  try {
    return Boolean(candidate) && fs.existsSync(candidate);
  } catch {
    return false;
  }
}

export function getGeminiAuthStatus(cwd) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability"
    };
  }

  const env = process.env;
  const apiKey =
    env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_API_KEY || null;
  if (apiKey) {
    return {
      available: true,
      loggedIn: true,
      detail: "API key configured via environment",
      source: "env"
    };
  }

  if (String(env.GOOGLE_GENAI_USE_VERTEXAI ?? "").toLowerCase() === "true") {
    return {
      available: true,
      loggedIn: true,
      detail: "Vertex AI configured via environment",
      source: "vertex"
    };
  }

  const geminiHome = env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
  const oauthCreds = path.join(geminiHome, "oauth_creds.json");
  const accounts = path.join(geminiHome, "google_accounts.json");
  if (fileExists(oauthCreds) || fileExists(accounts)) {
    return {
      available: true,
      loggedIn: true,
      detail: "Google account login active",
      source: "oauth"
    };
  }

  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "none"
  };
}

export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "direct startup",
    detail: "Each Gemini review launches a fresh one-shot gemini process.",
    endpoint: null
  };
}

function buildGeminiArgs(options = {}) {
  const args = [
    "-p",
    options.directive ?? DEFAULT_REVIEW_DIRECTIVE,
    "-o",
    "json",
    "--skip-trust"
  ];
  if (options.planMode !== false) {
    args.push("--approval-mode", "plan");
  }
  const model = normalizeRequestedModel(options.model);
  if (model) {
    args.push("-m", model);
  }
  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  return args;
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function parseGeminiEnvelope(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return { envelope: null, parseError: "Gemini returned no stdout." };
  }
  try {
    return { envelope: JSON.parse(text), parseError: null };
  } catch (error) {
    const candidate = extractJsonObject(text);
    if (candidate) {
      try {
        return { envelope: JSON.parse(candidate), parseError: null };
      } catch (innerError) {
        return { envelope: null, parseError: innerError.message };
      }
    }
    return { envelope: null, parseError: error.message };
  }
}

/**
 * Runs a single one-shot `gemini -p` invocation.
 * The full composed prompt is delivered on stdin; a short directive in -p
 * triggers headless mode and is appended after the stdin content.
 */
export function runGemini(cwd, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli`, then rerun `/gemini:setup`."
    );
  }

  const args = buildGeminiArgs(options);
  const result = spawnSync("gemini", args, {
    cwd,
    input: options.prompt ?? "",
    encoding: "utf8",
    maxBuffer: 96 * 1024 * 1024,
    env: options.env ?? process.env,
    windowsHide: true
  });

  const stderr = cleanGeminiStderr(result.stderr ?? "");

  if (result.error) {
    return {
      status: 1,
      sessionId: options.sessionId ?? null,
      responseText: "",
      stats: null,
      stderr: stderr || result.error.message,
      rawStdout: result.stdout ?? "",
      error: result.error.message
    };
  }

  const { envelope, parseError } = parseGeminiEnvelope(result.stdout);
  const exitStatus = result.status ?? 0;
  const responseText = typeof envelope?.response === "string" ? envelope.response : "";

  return {
    status: exitStatus === 0 && envelope && responseText ? 0 : 1,
    sessionId: envelope?.session_id ?? options.sessionId ?? null,
    responseText,
    stats: envelope?.stats ?? null,
    stderr,
    rawStdout: result.stdout ?? "",
    error: parseError
  };
}

export function runGeminiReview(cwd, options = {}) {
  return runGemini(cwd, {
    ...options,
    directive: DEFAULT_REVIEW_DIRECTIVE,
    planMode: true
  });
}

export function runStopGateReview(cwd, options = {}) {
  return runGemini(cwd, {
    ...options,
    directive: DEFAULT_STOP_GATE_DIRECTIVE,
    planMode: true
  });
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Gemini did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const tryParse = (candidate) => JSON.parse(candidate);

  try {
    return { parsed: tryParse(rawOutput), parseError: null, rawOutput, ...fallback };
  } catch (error) {
    const candidate = extractJsonObject(String(rawOutput));
    if (candidate) {
      try {
        return { parsed: tryParse(candidate), parseError: null, rawOutput, ...fallback };
      } catch (innerError) {
        return { parsed: null, parseError: innerError.message, rawOutput, ...fallback };
      }
    }
    return { parsed: null, parseError: error.message, rawOutput, ...fallback };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { MODEL_ALIASES, DEFAULT_REVIEW_DIRECTIVE, DEFAULT_STOP_GATE_DIRECTIVE };
