import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DAILY_AUDIT_PROPOSALS_SCHEMA,
  ProposalGenerationError,
  buildResponsesRequest,
  generateAndWriteRankedProposals,
} from "./generate-ranked-proposals.mjs";

const FIXED_NOW = "2026-07-22T00:00:00.000Z";
const RESPONSE_ID = "resp_fixture_123";

test("valid audit bundle creates a background strict json_schema Responses request", async () => {
  const outputDir = await createAuditBundle();
  const requests = [];

  try {
    await generateAndWriteRankedProposals({
      outputDir,
      env: buildEnv(),
      fetchImpl: createMockOpenAIFetch(
        [
          {
            body: createResponse({
              status: "completed",
              outputText: JSON.stringify(validProposalOutput()),
            }),
          },
        ],
        requests,
      ),
      now: fixedNow,
      clock: fixedClock(),
      sleep: async () => {},
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].pathname, "/v1/responses");
    assert.equal(requests[0].body.model, "gpt-fixture");
    assert.equal(requests[0].body.background, true);
    assert.equal(requests[0].body.text.format.type, "json_schema");
    assert.equal(requests[0].body.text.format.name, "daily_audit_proposals");
    assert.equal(requests[0].body.text.format.strict, true);
    assert.deepEqual(requests[0].body.text.format.schema.required, [
      "generated_at",
      "site_stack",
      "proposals",
    ]);
    assert.equal(requests[0].body.text.format.schema.additionalProperties, false);
    assert.equal(
      requests[0].body.text.format.schema.properties.proposals.items
        .additionalProperties,
      false,
    );
    assert.deepEqual(
      requests[0].body.text.format.schema.properties.proposals.items.required,
      [
        "proposal_id",
        "category",
        "evidence",
        "impact_score",
        "implementation_cost_score",
        "risk_score",
        "test_ease_score",
        "overall_priority",
        "recommended_action",
      ],
    );
    assert.equal(
      requests[0].body.input.some((item) =>
        item.content.includes('"searchConsole"'),
      ),
      true,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("buildResponsesRequest keeps the exact required schema fields", () => {
  const request = buildResponsesRequest({
    auditBundleJson: "{}",
    model: "gpt-fixture",
  });
  const schema = request.text.format.schema;
  const proposalSchema = schema.properties.proposals.items;

  assert.equal(request.model, "gpt-fixture");
  assert.equal(schema.additionalProperties, false);
  assert.equal(proposalSchema.additionalProperties, false);
  assert.deepEqual(schema.required, DAILY_AUDIT_PROPOSALS_SCHEMA.required);
  assert.deepEqual(proposalSchema.required, [
    "proposal_id",
    "category",
    "evidence",
    "impact_score",
    "implementation_cost_score",
    "risk_score",
    "test_ease_score",
    "overall_priority",
    "recommended_action",
  ]);
});

test("missing model prevents any OpenAI request", async () => {
  const outputDir = await createAuditBundle();
  const requests = [];

  try {
    await assert.rejects(
      generateAndWriteRankedProposals({
        outputDir,
        env: buildEnv({
          OPENAI_AUDIT_PROPOSAL_MODEL: "",
        }),
        fetchImpl: createMockOpenAIFetch([], requests),
        now: fixedNow,
      }),
      ProposalGenerationError,
    );

    assert.equal(requests.length, 0);
    const metadata = await readMetadata(outputDir);
    assert.equal(metadata.requestError.code, "missing_or_invalid_openai_configuration");
    assert.equal(
      metadata.requestError.details.some(
        (detail) => detail.envVar === "OPENAI_AUDIT_PROPOSAL_MODEL",
      ),
      true,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("missing token prevents any OpenAI request and is not written", async () => {
  const outputDir = await createAuditBundle();
  const requests = [];

  try {
    await assert.rejects(
      generateAndWriteRankedProposals({
        outputDir,
        env: buildEnv({
          OPENAI_ACCESS_TOKEN: "",
        }),
        fetchImpl: createMockOpenAIFetch([], requests),
        now: fixedNow,
      }),
      ProposalGenerationError,
    );

    assert.equal(requests.length, 0);
    const metadataText = await readFile(
      path.join(outputDir, "openai-proposal-response-metadata.json"),
      "utf8",
    );
    assert.equal(metadataText.includes("fixture-token"), false);
    assert.equal(metadataText.includes("authorization"), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("invalid audit-bundle JSON prevents any OpenAI request", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "ranked-proposals-"));
  const requests = [];

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "audit-bundle.json"), "{", "utf8");

    await assert.rejects(
      generateAndWriteRankedProposals({
        outputDir,
        env: buildEnv(),
        fetchImpl: createMockOpenAIFetch([], requests),
        now: fixedNow,
      }),
      ProposalGenerationError,
    );

    assert.equal(requests.length, 0);
    const metadata = await readMetadata(outputDir);
    assert.equal(metadata.requestError.code, "invalid_audit_bundle_json");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("queued and in_progress responses are polled until completion", async () => {
  const outputDir = await createAuditBundle();
  const requests = [];

  try {
    await generateAndWriteRankedProposals({
      outputDir,
      env: buildEnv(),
      fetchImpl: createMockOpenAIFetch(
        [
          {
            body: createResponse({ status: "queued" }),
          },
          {
            body: createResponse({ status: "in_progress" }),
          },
          {
            body: createResponse({
              status: "completed",
              outputText: JSON.stringify(validProposalOutput()),
            }),
          },
        ],
        requests,
      ),
      now: fixedNow,
      clock: fixedClock(),
      sleep: async () => {},
    });

    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.pathname}`),
      [
        "POST /v1/responses",
        `GET /v1/responses/${RESPONSE_ID}`,
        `GET /v1/responses/${RESPONSE_ID}`,
      ],
    );
    const metadata = await readMetadata(outputDir);
    assert.equal(metadata.polling.attempts, 2);
    assert.equal(metadata.responseId, RESPONSE_ID);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("successful terminal response writes ranked-proposals.json", async () => {
  const outputDir = await createAuditBundle();
  const output = validProposalOutput();

  try {
    await generateAndWriteRankedProposals({
      outputDir,
      env: buildEnv(),
      fetchImpl: createMockOpenAIFetch([
        {
          body: createResponse({
            status: "completed",
            outputText: JSON.stringify(output),
          }),
        },
      ]),
      now: fixedNow,
      clock: fixedClock(),
      sleep: async () => {},
    });

    const rankedProposals = JSON.parse(
      await readFile(path.join(outputDir, "ranked-proposals.json"), "utf8"),
    );
    assert.deepEqual(rankedProposals, output);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("invalid structured output is rejected and ranked-proposals.json is not written", async () => {
  const outputDir = await createAuditBundle();

  try {
    await assert.rejects(
      generateAndWriteRankedProposals({
        outputDir,
        env: buildEnv(),
        fetchImpl: createMockOpenAIFetch([
          {
            body: createResponse({
              status: "completed",
              outputText: "not-json",
            }),
          },
        ]),
        now: fixedNow,
        clock: fixedClock(),
        sleep: async () => {},
      }),
      ProposalGenerationError,
    );

    await assert.rejects(
      readFile(path.join(outputDir, "ranked-proposals.json"), "utf8"),
      /ENOENT/,
    );
    const metadata = await readMetadata(outputDir);
    assert.equal(metadata.responseError.code, "invalid_structured_output_json");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("additional proposal properties are rejected", async () => {
  const outputDir = await createAuditBundle();
  const output = validProposalOutput();
  output.proposals[0].extra = "not allowed";

  try {
    await assert.rejects(
      generateAndWriteRankedProposals({
        outputDir,
        env: buildEnv(),
        fetchImpl: createMockOpenAIFetch([
          {
            body: createResponse({
              status: "completed",
              outputText: JSON.stringify(output),
            }),
          },
        ]),
        now: fixedNow,
        clock: fixedClock(),
        sleep: async () => {},
      }),
      ProposalGenerationError,
    );

    const metadata = await readMetadata(outputDir);
    assert.equal(
      metadata.responseError.code,
      "structured_output_schema_validation_failed",
    );
    assert.equal(
      metadata.responseError.details.includes(
        "$.proposals[0].extra is not allowed",
      ),
      true,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("timeout causes cancellation attempt and preserves response ID in metadata", async () => {
  const outputDir = await createAuditBundle();
  const requests = [];
  const clock = advancingClock([0, 2, 4, 6]);

  try {
    await assert.rejects(
      generateAndWriteRankedProposals({
        outputDir,
        env: buildEnv({
          OPENAI_AUDIT_PROPOSAL_POLL_INTERVAL_MS: "2",
          OPENAI_AUDIT_PROPOSAL_TIMEOUT_MS: "5",
        }),
        fetchImpl: createMockOpenAIFetch(
          [
            {
              body: createResponse({ status: "queued" }),
            },
            {
              body: createResponse({ status: "in_progress" }),
            },
            {
              body: createResponse({ status: "cancelled" }),
            },
          ],
          requests,
        ),
        now: fixedNow,
        clock,
        sleep: async () => {},
      }),
      ProposalGenerationError,
    );

    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.pathname}`),
      [
        "POST /v1/responses",
        `GET /v1/responses/${RESPONSE_ID}`,
        `POST /v1/responses/${RESPONSE_ID}/cancel`,
      ],
    );
    const metadata = await readMetadata(outputDir);
    assert.equal(metadata.timedOut, true);
    assert.equal(metadata.responseId, RESPONSE_ID);
    assert.equal(metadata.cancellationAttempted, true);
    assert.equal(metadata.cancellationResult.status, "succeeded");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Authorization value is not written to output or metadata", async () => {
  const outputDir = await createAuditBundle();
  const token = "secret-fixture-token";

  try {
    await generateAndWriteRankedProposals({
      outputDir,
      env: buildEnv({
        OPENAI_ACCESS_TOKEN: token,
      }),
      fetchImpl: createMockOpenAIFetch(
        [
          {
            body: createResponse({
              status: "completed",
              outputText: JSON.stringify(validProposalOutput()),
            }),
          },
        ],
        [],
        token,
      ),
      now: fixedNow,
      clock: fixedClock(),
      sleep: async () => {},
    });

    const metadataText = await readFile(
      path.join(outputDir, "openai-proposal-response-metadata.json"),
      "utf8",
    );
    const proposalsText = await readFile(
      path.join(outputDir, "ranked-proposals.json"),
      "utf8",
    );

    assert.equal(metadataText.includes(token), false);
    assert.equal(proposalsText.includes(token), false);
    assert.equal(metadataText.includes("Authorization"), false);
    assert.equal(metadataText.includes("authorization"), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("mocked requests never call repository, dispatch, or Codex endpoints", async () => {
  const outputDir = await createAuditBundle();
  const requests = [];

  try {
    await generateAndWriteRankedProposals({
      outputDir,
      env: buildEnv(),
      fetchImpl: createMockOpenAIFetch(
        [
          {
            body: createResponse({
              status: "completed",
              outputText: JSON.stringify(validProposalOutput()),
            }),
          },
        ],
        requests,
      ),
      now: fixedNow,
      clock: fixedClock(),
      sleep: async () => {},
    });

    assert.equal(
      requests.every((request) => request.origin === "https://api.openai.com"),
      true,
    );
    assert.equal(
      requests.some((request) =>
        /\/repos\/|\/dispatches|codex|workflows/i.test(request.pathname),
      ),
      false,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("generator does not modify public files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ranked-proposals-public-"));
  const outputDir = path.join(tempDir, "out", "audit-bundle");
  const publicDir = path.join(tempDir, "public");
  const publicFile = path.join(publicDir, "index.html");

  try {
    await mkdir(publicDir, { recursive: true });
    await writeFile(publicFile, "<!doctype html>\n<title>unchanged</title>\n", "utf8");
    await createAuditBundle({}, outputDir);

    await generateAndWriteRankedProposals({
      outputDir,
      env: buildEnv(),
      fetchImpl: createMockOpenAIFetch([
        {
          body: createResponse({
            status: "completed",
            outputText: JSON.stringify(validProposalOutput()),
          }),
        },
      ]),
      now: fixedNow,
      clock: fixedClock(),
      sleep: async () => {},
    });

    assert.equal(
      await readFile(publicFile, "utf8"),
      "<!doctype html>\n<title>unchanged</title>\n",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function buildEnv(overrides = {}) {
  return {
    OPENAI_ACCESS_TOKEN: "fixture-token",
    OPENAI_AUDIT_PROPOSAL_MODEL: "gpt-fixture",
    ...overrides,
  };
}

function validProposalOutput() {
  return {
    generated_at: FIXED_NOW,
    site_stack: "Static Cloudflare Pages site based on supplied audit evidence.",
    proposals: [
      {
        proposal_id: "proposal-001",
        category: "SEO",
        evidence: ["searchConsole.searchAnalytics reports are present."],
        impact_score: 4,
        implementation_cost_score: 2,
        risk_score: 1,
        test_ease_score: 4,
        overall_priority: "high",
        recommended_action:
          "Review Search Console page evidence and propose one content improvement.",
      },
    ],
  };
}

function createResponse({ status, outputText }) {
  const response = {
    id: RESPONSE_ID,
    object: "response",
    status,
    model: "gpt-fixture",
    created_at: 1784678400,
    completed_at: status === "completed" ? 1784678401 : null,
    output: [],
  };

  if (outputText !== undefined) {
    response.output = [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: outputText,
          },
        ],
      },
    ];
  }

  return response;
}

function createMockOpenAIFetch(routes, requests = [], expectedToken = "fixture-token") {
  const queuedRoutes = [...routes];

  return async (url, options = {}) => {
    const parsedUrl = new URL(url);
    const route = queuedRoutes.shift();

    requests.push({
      origin: parsedUrl.origin,
      method: options.method ?? "GET",
      pathname: parsedUrl.pathname,
      authorization: options.headers?.authorization ?? null,
      body: options.body ? JSON.parse(options.body) : null,
    });

    assert.equal(parsedUrl.origin, "https://api.openai.com");
    assert.equal(options.headers.authorization, `Bearer ${expectedToken}`);

    if (!route) {
      throw new Error(`Unexpected OpenAI API request: ${parsedUrl.pathname}`);
    }

    return jsonResponse(route.body, {
      status: route.status ?? 200,
    });
  };
}

async function createAuditBundle(
  bundle = {
    searchConsole: {
      searchAnalytics: {
        reports: [],
      },
    },
  },
  outputDir,
) {
  const resolvedOutputDir =
    outputDir ?? (await mkdtemp(path.join(tmpdir(), "ranked-proposals-")));

  await mkdir(resolvedOutputDir, { recursive: true });
  await writeFile(
    path.join(resolvedOutputDir, "audit-bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
    "utf8",
  );

  return resolvedOutputDir;
}

async function readMetadata(outputDir) {
  return JSON.parse(
    await readFile(
      path.join(outputDir, "openai-proposal-response-metadata.json"),
      "utf8",
    ),
  );
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

function fixedNow() {
  return new Date(FIXED_NOW);
}

function fixedClock(value = 0) {
  return () => value;
}

function advancingClock(values) {
  const queue = [...values];
  let lastValue = queue[0] ?? 0;

  return () => {
    lastValue = queue.length ? queue.shift() : lastValue;
    return lastValue;
  };
}
