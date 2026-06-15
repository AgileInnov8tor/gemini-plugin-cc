#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getGeminiAuthStatus,
  getGeminiAvailability,
  getSessionRuntimeStatus,
  normalizeRequestedModel,
  parseStructuredOutput,
  readOutputSchema,
  runGeminiReview,
  runStopGateReview
} from "./lib/gemini.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <pro|flash|name>] [--json] [focus text]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <pro|flash|name>] [--json] [focus text]",
      "  node scripts/gemini-companion.mjs status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function ensureGeminiAvailable(cwd) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli`, then rerun `/gemini:setup`."
    );
  }
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const geminiStatus = getGeminiAvailability(cwd);
  const authStatus = getGeminiAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!geminiStatus.available) {
    nextSteps.push("Install the Gemini CLI with `npm install -g @google/gemini-cli`.");
  }
  if (geminiStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Authenticate Gemini: run `!gemini` once and sign in, or set `GEMINI_API_KEY`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/gemini:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && geminiStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    gemini: geminiStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildReviewPrompt(reviewName, context, focusText) {
  const templateName = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

const REVIEW_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const REVIEW_VERDICTS = new Set(["approve", "needs-attention"]);

function validateReviewPayload(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Expected a top-level JSON object.";
  }
  if (!REVIEW_VERDICTS.has(parsed.verdict)) {
    return "`verdict` must be \"approve\" or \"needs-attention\".";
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(parsed.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(parsed.next_steps)) {
    return "Missing array `next_steps`.";
  }
  for (const [index, finding] of parsed.findings.entries()) {
    if (!finding || typeof finding !== "object") {
      return `Finding ${index + 1} is not an object.`;
    }
    if (!REVIEW_SEVERITIES.has(finding.severity)) {
      return `Finding ${index + 1} has an invalid \`severity\`.`;
    }
    for (const key of ["title", "body", "file"]) {
      if (typeof finding[key] !== "string" || !finding[key].trim()) {
        return `Finding ${index + 1} is missing string \`${key}\`.`;
      }
    }
  }
  return null;
}

function readReviewSchemaSafely() {
  try {
    return readOutputSchema(REVIEW_SCHEMA);
  } catch {
    return null;
  }
}

function executeReviewRun(request) {
  ensureGeminiAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  // Reading the schema keeps the in-prompt contract and the validator in sync.
  readReviewSchemaSafely();

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(reviewName, context, focusText);

  request.onProgress?.({ message: `Running Gemini ${reviewName}.`, phase: "reviewing" });

  const result = runGeminiReview(context.repoRoot, {
    prompt,
    model: request.model,
    sessionId: request.sessionId
  });

  const parsed = parseStructuredOutput(result.responseText, {
    status: result.status,
    failureMessage: result.error ?? result.stderr
  });

  if (parsed.parsed && !parsed.parseError) {
    const validationError = validateReviewPayload(parsed.parsed);
    if (validationError) {
      parsed.parseError = validationError;
    }
  }

  const payload = {
    review: reviewName,
    target,
    sessionId: result.sessionId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    gemini: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.responseText
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError
  };

  return {
    exitStatus: result.status,
    geminiSessionId: result.sessionId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label
    }),
    summary:
      parsed.parsed?.summary ??
      parsed.parseError ??
      firstMeaningfulLine(result.responseText, `${reviewName} finished.`),
    jobTitle: `Gemini ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Gemini Review" : `Gemini ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function getReviewKindLabel(kind) {
  return kind === "adversarial-review" ? "adversarial-review" : "review";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, summary, sessionId }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getReviewKindLabel(kind),
    title,
    workspaceRoot,
    jobClass: "review",
    summary,
    geminiSessionId: sessionId ?? null
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gemini-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundReview(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

function renderQueuedReviewLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check \`/gemini:status ${payload.jobId}\` for progress.\n`;
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const model = normalizeRequestedModel(options.model);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const sessionId = randomUUID();
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    summary: metadata.summary,
    sessionId
  });

  if (options.background) {
    ensureGeminiAvailable(cwd);
    const request = {
      cwd,
      base: options.base ?? null,
      scope: options.scope ?? null,
      model,
      focusText,
      reviewName: config.reviewName,
      sessionId
    };
    const { payload } = enqueueBackgroundReview(cwd, job, request);
    outputCommandResult(payload, renderQueuedReviewLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        focusText,
        reviewName: config.reviewName,
        sessionId,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review" });
}

async function handleAdversarialReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Adversarial Review" });
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its review request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => executeReviewRun({ ...request, onProgress: progress }),
    { logFile }
  );
}

async function handleStopGateReview(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "base", "scope", "model"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  ensureGeminiAvailable(cwd);
  ensureGitRepository(cwd);

  const lastMessage = readStdinIfPiped().trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope ?? "working-tree"
  });
  const context = collectReviewContext(cwd, target);
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastMessage
    ? ["Previous Claude response:", lastMessage].join("\n")
    : "";
  const prompt = interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock,
    REVIEW_INPUT: context.content
  });

  const result = runStopGateReview(context.repoRoot, {
    prompt,
    model: normalizeRequestedModel(options.model)
  });

  const payload = {
    status: result.status,
    sessionId: result.sessionId,
    rawOutput: result.responseText,
    stderr: result.stderr
  };
  outputResult(options.json ? payload : `${result.responseText}\n`, options.json);
  if (result.status !== 0) {
    process.exitCode = result.status;
  }
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all, env: process.env });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleAdversarialReview(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "stop-gate-review":
      await handleStopGateReview(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
