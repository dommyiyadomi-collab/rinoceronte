#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "out", "audit-bundle");
const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_ACCESS_TOKEN_ENV_VAR = "OPENAI_ACCESS_TOKEN";
const OPENAI_MODEL_ENV_VAR = "OPENAI_AUDIT_PROPOSAL_MODEL";
const OPENAI_POLL_INTERVAL_ENV_VAR =
  "OPENAI_AUDIT_PROPOSAL_POLL_INTERVAL_MS";
const OPENAI_TIMEOUT_ENV_VAR = "OPENAI_AUDIT_PROPOSAL_TIMEOUT_MS";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const TERMINAL_PENDING_STATUSES = new Set(["queued", "in_progress"]);
const SUCCESS_STATUS = "completed";
const PROPOSAL_CATEGORIES = [
  "UX",
  "SEO",
  "performance",
  "security",
  "content",
  "monetization",
];
const TOP_LEVEL_FIELDS = ["generated_at", "site_stack", "proposals"];
const PROPOSAL_FIELDS = [
  "proposal_id",
  "category",
  "evidence",
  "impact_score",
  "implementation_cost_score",
  "risk_score",
  "test_ease_score",
  "overall_priority",
  "recommended_action",
];

export const DAILY_AUDIT_PROPOSALS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: TOP_LEVEL_FIELDS,
  properties: {
    generated_at: {
      type: "string",
      description:
        "ISO 8601 timestamp for when the proposal result was generated.",
    },
    site_stack: {
      type: "string",
      description:
        "Concise site-stack summary supported only by the supplied audit bundle.",
    },
    proposals: {
      type: "array",
      description:
        "Ranked proposals in model-returned order. Return an empty array when the bundle does not support proposals.",
      items: {
        type: "object",
        additionalProperties: false,
        required: PROPOSAL_FIELDS,
        properties: {
          proposal_id: {
            type: "string",
          },
          category: {
            type: "string",
            enum: PROPOSAL_CATEGORIES,
          },
          evidence: {
            type: "array",
            items: {
              type: "string",
            },
          },
          impact_score: {
            type: "number",
          },
          implementation_cost_score: {
            type: "number",
          },
          risk_score: {
            type: "number",
          },
          test_ease_score: {
            type: "number",
          },
          overall_priority: {
            type: "string",
          },
          recommended_action: {
            type: "string",
          },
        },
      },
    },
  },
};

const SYSTEM_INSTRUCTIONS = [
  "You generate structured daily site-audit proposals for Japan Remote Guide.",
  "Use only evidence found in the supplied audit-bundle.json.",
  "Do not claim facts not present in the audit bundle.",
  "Do not fabricate metrics.",
  "Do not claim certainty where evidence is missing.",
  "Return an empty proposals array when no supported proposal can be produced.",
  "Do not implement changes.",
  "Do not generate source code.",
  "Do not dispatch workflows.",
  "Do not modify the repository.",
  "Return only the required structured result.",
].join("\n");

export class ProposalGenerationError extends Error {
  constructor(message, { code, details } = {}) {
    super(message);
    this.name = "ProposalGenerationError";
    this.code = code;
    this.details = details;
  }
}

class OpenAIRequestError extends Error {
  constructor(message, { endpoint, method, statusCode, body } = {}) {
    super(message);
    this.name = "OpenAIRequestError";
    this.endpoint = endpoint;
    this.method = method;
    this.statusCode = statusCode;
    this.body = body;
  }
}

export async function main({
  argv = process.argv,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
  clock = () => Date.now(),
  sleep = sleepMs,
} = {}) {
  const outputDir = argv[2] ? path.resolve(argv[2]) : DEFAULT_OUTPUT_DIR;
  const result = await generateAndWriteRankedProposals({
    outputDir,
    env,
    fetchImpl,
    now,
    clock,
    sleep,
  });

  console.log(
    `Generated ranked proposals at ${result.rankedProposalsPath} from OpenAI response ${result.metadata.responseId}.`,
  );

  return result;
}

export async function generateAndWriteRankedProposals({
  outputDir = DEFAULT_OUTPUT_DIR,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
  clock = () => Date.now(),
  sleep = sleepMs,
} = {}) {
  const resolvedOutputDir = path.resolve(outputDir);
  const generatedAt = now().toISOString();
  const auditBundlePath = path.join(resolvedOutputDir, "audit-bundle.json");
  const rankedProposalsPath = path.join(
    resolvedOutputDir,
    "ranked-proposals.json",
  );
  const metadataPath = path.join(
    resolvedOutputDir,
    "openai-proposal-response-metadata.json",
  );

  await mkdir(resolvedOutputDir, { recursive: true });

  const metadata = createMetadata({
    generatedAt,
    auditBundlePath,
    rankedProposalsPath,
  });

  let rawAuditBundle;

  try {
    rawAuditBundle = await readFile(auditBundlePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      metadata.requestError = {
        code: "missing_audit_bundle",
        message: `${auditBundlePath} was not found.`,
      };
      await writeJson(metadataPath, metadata);
      throw new ProposalGenerationError(metadata.requestError.message, {
        code: metadata.requestError.code,
      });
    }

    throw error;
  }

  try {
    JSON.parse(rawAuditBundle);
  } catch {
    metadata.requestError = {
      code: "invalid_audit_bundle_json",
      message: `${auditBundlePath} does not contain valid JSON.`,
    };
    await writeJson(metadataPath, metadata);
    throw new ProposalGenerationError(metadata.requestError.message, {
      code: metadata.requestError.code,
    });
  }

  const configuration = readConfiguration(env);
  metadata.model = configuration.model;
  metadata.polling = {
    intervalMs: configuration.pollIntervalMs,
    intervalSource: configuration.pollIntervalSource,
    timeoutMs: configuration.timeoutMs,
    timeoutSource: configuration.timeoutSource,
    attempts: 0,
  };

  if (configuration.errors.length > 0) {
    metadata.requestError = {
      code: "missing_or_invalid_openai_configuration",
      message:
        "OpenAI proposal generation is not configured. No OpenAI request was made.",
      details: configuration.errors,
    };
    await writeJson(metadataPath, metadata);
    throw new ProposalGenerationError(metadata.requestError.message, {
      code: metadata.requestError.code,
      details: configuration.errors,
    });
  }

  const requestBody = buildResponsesRequest({
    auditBundleJson: rawAuditBundle,
    model: configuration.model,
  });

  let response = null;

  try {
    response = await sendOpenAIJsonRequest({
      fetchImpl,
      token: configuration.token,
      method: "POST",
      url: OPENAI_RESPONSES_ENDPOINT,
      body: requestBody,
    });
  } catch (error) {
    metadata.requestError = serializeRequestError(error, configuration.token);
    await writeJson(metadataPath, metadata);
    throw new ProposalGenerationError(
      "OpenAI Responses API request failed before proposal generation completed.",
      {
        code: metadata.requestError.code,
      },
    );
  }

  recordResponseMetadata(metadata, response);

  response = await pollUntilTerminal({
    response,
    metadata,
    fetchImpl,
    token: configuration.token,
    timeoutMs: configuration.timeoutMs,
    pollIntervalMs: configuration.pollIntervalMs,
    clock,
    sleep,
  });

  recordResponseMetadata(metadata, response);

  if (metadata.timedOut) {
    await writeJson(metadataPath, metadata);
    throw new ProposalGenerationError(
      `OpenAI response ${metadata.responseId} did not finish before the configured timeout.`,
      {
        code: "openai_response_timeout",
      },
    );
  }

  if (response.status !== SUCCESS_STATUS) {
    metadata.responseError = {
      code: "openai_response_terminal_failure",
      status: response.status ?? null,
      error: response.error ?? null,
    };
    await writeJson(metadataPath, metadata);
    throw new ProposalGenerationError(
      `OpenAI response ${metadata.responseId ?? "(missing id)"} ended with status ${response.status ?? "(missing status)"}.`,
      {
        code: metadata.responseError.code,
      },
    );
  }

  const structuredText = extractStructuredOutputText(response);

  if (!structuredText) {
    metadata.responseError = {
      code: "missing_structured_output",
      message: "The completed OpenAI response did not contain structured text output.",
    };
    await writeJson(metadataPath, metadata);
    throw new ProposalGenerationError(metadata.responseError.message, {
      code: metadata.responseError.code,
    });
  }

  let proposals;

  try {
    proposals = JSON.parse(structuredText);
  } catch {
    metadata.responseError = {
      code: "invalid_structured_output_json",
      message: "The completed OpenAI response output was not valid JSON.",
    };
    await writeJson(metadataPath, metadata);
    throw new ProposalGenerationError(metadata.responseError.message, {
      code: metadata.responseError.code,
    });
  }

  const validationErrors = validateRankedProposals(proposals);

  if (validationErrors.length > 0) {
    metadata.responseError = {
      code: "structured_output_schema_validation_failed",
      message: "The completed OpenAI response did not match daily_audit_proposals.",
      details: validationErrors,
    };
    await writeJson(metadataPath, metadata);
    throw new ProposalGenerationError(metadata.responseError.message, {
      code: metadata.responseError.code,
      details: validationErrors,
    });
  }

  await writeJson(rankedProposalsPath, proposals);
  await writeJson(metadataPath, metadata);

  return {
    rankedProposalsPath,
    metadataPath,
    proposals,
    metadata,
  };
}

export function buildResponsesRequest({ auditBundleJson, model }) {
  return {
    model,
    background: true,
    input: [
      {
        role: "system",
        content: SYSTEM_INSTRUCTIONS,
      },
      {
        role: "user",
        content: auditBundleJson,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "daily_audit_proposals",
        strict: true,
        schema: DAILY_AUDIT_PROPOSALS_SCHEMA,
      },
    },
  };
}

export function validateRankedProposals(value) {
  const errors = [];

  if (!isPlainObject(value)) {
    return ["top-level value must be an object"];
  }

  assertRequiredFields(value, TOP_LEVEL_FIELDS, "$", errors);
  assertOnlyFields(value, TOP_LEVEL_FIELDS, "$", errors);

  if ("generated_at" in value && typeof value.generated_at !== "string") {
    errors.push("$.generated_at must be a string");
  }

  if ("site_stack" in value && typeof value.site_stack !== "string") {
    errors.push("$.site_stack must be a string");
  }

  if ("proposals" in value && !Array.isArray(value.proposals)) {
    errors.push("$.proposals must be an array");
  }

  if (Array.isArray(value.proposals)) {
    value.proposals.forEach((proposal, index) => {
      const pathPrefix = `$.proposals[${index}]`;

      if (!isPlainObject(proposal)) {
        errors.push(`${pathPrefix} must be an object`);
        return;
      }

      assertRequiredFields(proposal, PROPOSAL_FIELDS, pathPrefix, errors);
      assertOnlyFields(proposal, PROPOSAL_FIELDS, pathPrefix, errors);

      if (
        "proposal_id" in proposal &&
        typeof proposal.proposal_id !== "string"
      ) {
        errors.push(`${pathPrefix}.proposal_id must be a string`);
      }

      if (
        "category" in proposal &&
        !PROPOSAL_CATEGORIES.includes(proposal.category)
      ) {
        errors.push(
          `${pathPrefix}.category must be one of ${PROPOSAL_CATEGORIES.join(", ")}`,
        );
      }

      if ("evidence" in proposal) {
        if (!Array.isArray(proposal.evidence)) {
          errors.push(`${pathPrefix}.evidence must be an array`);
        } else {
          proposal.evidence.forEach((entry, evidenceIndex) => {
            if (typeof entry !== "string") {
              errors.push(
                `${pathPrefix}.evidence[${evidenceIndex}] must be a string`,
              );
            }
          });
        }
      }

      for (const field of [
        "impact_score",
        "implementation_cost_score",
        "risk_score",
        "test_ease_score",
      ]) {
        if (field in proposal && !isFiniteNumber(proposal[field])) {
          errors.push(`${pathPrefix}.${field} must be a finite number`);
        }
      }

      if (
        "overall_priority" in proposal &&
        typeof proposal.overall_priority !== "string"
      ) {
        errors.push(`${pathPrefix}.overall_priority must be a string`);
      }

      if (
        "recommended_action" in proposal &&
        typeof proposal.recommended_action !== "string"
      ) {
        errors.push(`${pathPrefix}.recommended_action must be a string`);
      }
    });
  }

  return errors;
}

async function pollUntilTerminal({
  response,
  metadata,
  fetchImpl,
  token,
  timeoutMs,
  pollIntervalMs,
  clock,
  sleep,
}) {
  let currentResponse = response;
  const responseId = currentResponse?.id;
  const deadline = clock() + timeoutMs;

  while (TERMINAL_PENDING_STATUSES.has(currentResponse?.status)) {
    const nowMs = clock();

    if (nowMs >= deadline) {
      await markTimedOutAndCancel({
        metadata,
        responseId,
        fetchImpl,
        token,
      });
      return currentResponse;
    }

    await sleep(Math.min(pollIntervalMs, deadline - nowMs));

    if (clock() > deadline) {
      await markTimedOutAndCancel({
        metadata,
        responseId,
        fetchImpl,
        token,
      });
      return currentResponse;
    }

    currentResponse = await sendOpenAIJsonRequest({
      fetchImpl,
      token,
      method: "GET",
      url: `${OPENAI_RESPONSES_ENDPOINT}/${encodeURIComponent(responseId)}`,
    });
    metadata.polling.attempts += 1;
    recordResponseMetadata(metadata, currentResponse);
  }

  return currentResponse;
}

async function markTimedOutAndCancel({ metadata, responseId, fetchImpl, token }) {
  metadata.timedOut = true;
  metadata.cancellationAttempted = Boolean(responseId);

  if (!responseId) {
    metadata.cancellationResult = {
      status: "skipped",
      reason: "missing_response_id",
    };
    return;
  }

  try {
    const cancelResponse = await sendOpenAIJsonRequest({
      fetchImpl,
      token,
      method: "POST",
      url: `${OPENAI_RESPONSES_ENDPOINT}/${encodeURIComponent(responseId)}/cancel`,
    });

    metadata.cancellationResult = {
      status: "succeeded",
      responseId: cancelResponse.id ?? null,
      responseStatus: cancelResponse.status ?? null,
    };
  } catch (error) {
    metadata.cancellationResult = {
      status: "failed",
      error: serializeRequestError(error, token),
    };
  }
}

async function sendOpenAIJsonRequest({
  fetchImpl,
  token,
  method,
  url,
  body,
}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new OpenAIRequestError(
      `OpenAI request failed with HTTP ${response.status}.`,
      {
        endpoint: new URL(url).pathname,
        method,
        statusCode: response.status,
        body: responseBody,
      },
    );
  }

  return responseBody;
}

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function readConfiguration(env) {
  const errors = [];
  const model = stringOrNull(env[OPENAI_MODEL_ENV_VAR]);
  const token = stringOrNull(env[OPENAI_ACCESS_TOKEN_ENV_VAR]);
  const pollInterval = readPositiveIntegerConfiguration({
    env,
    envVar: OPENAI_POLL_INTERVAL_ENV_VAR,
    defaultValue: DEFAULT_POLL_INTERVAL_MS,
  });
  const timeout = readPositiveIntegerConfiguration({
    env,
    envVar: OPENAI_TIMEOUT_ENV_VAR,
    defaultValue: DEFAULT_TIMEOUT_MS,
  });

  if (!model) {
    errors.push({
      envVar: OPENAI_MODEL_ENV_VAR,
      reason: "missing",
    });
  }

  if (!token) {
    errors.push({
      envVar: OPENAI_ACCESS_TOKEN_ENV_VAR,
      reason: "missing",
    });
  }

  errors.push(...pollInterval.errors, ...timeout.errors);

  return {
    model,
    token,
    pollIntervalMs: pollInterval.value,
    pollIntervalSource: pollInterval.source,
    timeoutMs: timeout.value,
    timeoutSource: timeout.source,
    errors,
  };
}

function readPositiveIntegerConfiguration({ env, envVar, defaultValue }) {
  const rawValue = stringOrNull(env[envVar]);

  if (!rawValue) {
    return {
      value: defaultValue,
      source: "default",
      errors: [],
    };
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    return {
      value: defaultValue,
      source: "invalid",
      errors: [
        {
          envVar,
          reason: "invalid_positive_integer",
        },
      ],
    };
  }

  return {
    value,
    source: "environment",
    errors: [],
  };
}

function createMetadata({ generatedAt, auditBundlePath, rankedProposalsPath }) {
  return {
    generatedAt,
    request: {
      method: "POST",
      endpoint: "/v1/responses",
      background: true,
      schemaName: "daily_audit_proposals",
      strict: true,
      auditBundlePath,
      rankedProposalsPath,
    },
    responseId: null,
    model: null,
    status: null,
    createdAt: null,
    completedAt: null,
    polling: {
      intervalMs: null,
      intervalSource: null,
      timeoutMs: null,
      timeoutSource: null,
      attempts: 0,
    },
    timedOut: false,
    cancellationAttempted: false,
    cancellationResult: null,
    requestError: null,
    responseError: null,
  };
}

function recordResponseMetadata(metadata, response) {
  metadata.responseId = response?.id ?? metadata.responseId;
  metadata.model = response?.model ?? metadata.model;
  metadata.status = response?.status ?? metadata.status;
  metadata.createdAt = timestampToIsoString(response?.created_at) ?? metadata.createdAt;
  metadata.completedAt =
    timestampToIsoString(response?.completed_at) ?? metadata.completedAt;
}

function timestampToIsoString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return null;
}

function extractStructuredOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const outputItems = Array.isArray(response?.output) ? response.output : [];
  const textParts = [];

  for (const item of outputItems) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];

    for (const content of contentItems) {
      if (
        content?.type === "output_text" &&
        typeof content.text === "string"
      ) {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join("").trim();
}

function serializeRequestError(error, token) {
  if (error instanceof OpenAIRequestError) {
    return {
      code: "openai_request_failed",
      method: error.method,
      endpoint: error.endpoint,
      statusCode: error.statusCode,
      body: redactSensitiveValue(error.body, token),
      message: redactSensitiveValue(error.message, token),
    };
  }

  return {
    code: "openai_request_failed",
    message: redactSensitiveValue(
      error instanceof Error ? error.message : String(error),
      token,
    ),
  };
}

function assertRequiredFields(value, fields, pathPrefix, errors) {
  for (const field of fields) {
    if (!(field in value)) {
      errors.push(`${pathPrefix}.${field} is required`);
    }
  }
}

function assertOnlyFields(value, fields, pathPrefix, errors) {
  const allowed = new Set(fields);

  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      errors.push(`${pathPrefix}.${field} is not allowed`);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function stringOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const stringValue = String(value).trim();
  return stringValue || null;
}

function redactSensitiveValue(value, token) {
  if (!token) {
    return value;
  }

  if (typeof value === "string") {
    return value.split(token).join("[redacted]");
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, token));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactSensitiveValue(entry, token),
      ]),
    );
  }

  return value;
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isCli = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isCli) {
  main().catch((error) => {
    if (error instanceof ProposalGenerationError) {
      console.error(
        JSON.stringify({
          status: "failed",
          code: error.code ?? "proposal_generation_failed",
          message: error.message,
          details: error.details ?? null,
        }),
      );
    } else {
      console.error("Unexpected OpenAI proposal generation failure.");
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
}
