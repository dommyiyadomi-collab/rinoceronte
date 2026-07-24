import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(
  new URL("./record-proposal-decision.mjs", import.meta.url),
);

test("approve writes approval-decision.json and approved-proposal.json", async () => {
  await withTempDir(async (tempDir) => {
    const rankedProposalsPath = await writeRankedProposals(tempDir);
    const result = runRecorder({ tempDir, rankedProposalsPath });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);

    const outputDir = outputPath(tempDir);
    assert.deepEqual((await readdir(outputDir)).sort(), [
      "approval-decision.json",
      "approved-proposal.json",
    ]);

    const decision = await readJson(
      path.join(outputDir, "approval-decision.json"),
    );
    const approved = await readJson(
      path.join(outputDir, "approved-proposal.json"),
    );

    assert.equal(decision.proposal_id, "proposal-001");
    assert.equal(decision.decision, "approve");
    assert.equal(decision.source_run_id, "run-123");
    assert.equal(decision.decided_by, "approver");
    assert.equal(approved.proposal.proposal_id, "proposal-001");
  });
});

test("reject writes only approval-decision.json", async () => {
  await assertDecisionWithoutApprovedProposal("reject");
});

test("defer writes only approval-decision.json", async () => {
  await assertDecisionWithoutApprovedProposal("defer");
});

test("unknown proposal_id fails", async () => {
  await withTempDir(async (tempDir) => {
    const rankedProposalsPath = await writeRankedProposals(tempDir);
    const result = runRecorder({
      tempDir,
      rankedProposalsPath,
      env: {
        PROPOSAL_ID: "proposal-missing",
      },
    });

    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Proposal proposal-missing was not found in ranked-proposals\.json\./,
    );
    assert.equal(await pathExists(outputPath(tempDir)), false);
  });
});

test("invalid decision fails", async () => {
  await withTempDir(async (tempDir) => {
    const rankedProposalsPath = await writeRankedProposals(tempDir);
    const result = runRecorder({
      tempDir,
      rankedProposalsPath,
      env: {
        DECISION: "ship",
      },
    });

    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Invalid decision: ship\. Expected approve, reject, or defer\./,
    );
    assert.equal(await pathExists(outputPath(tempDir)), false);
  });
});

test("missing required environment variable fails clearly", async () => {
  await withTempDir(async (tempDir) => {
    const rankedProposalsPath = await writeRankedProposals(tempDir);
    const result = runRecorder({
      tempDir,
      rankedProposalsPath,
      env: {
        SOURCE_RUN_ID: "",
      },
    });

    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Missing required environment variable: SOURCE_RUN_ID\./,
    );
    assert.equal(await pathExists(outputPath(tempDir)), false);
  });
});

test("decision_reason safely preserves quotes, newline, dollar, semicolon, and backtick", async () => {
  await withTempDir(async (tempDir) => {
    const rankedProposalsPath = await writeRankedProposals(tempDir);
    const decisionReason =
      "double \" quote\nsingle ' quote\nliteral $VALUE\nsemicolon ; stays text\nbacktick `echo unsafe`";

    const result = runRecorder({
      tempDir,
      rankedProposalsPath,
      env: {
        DECISION_REASON: decisionReason,
      },
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);

    const outputDir = outputPath(tempDir);
    const decision = await readJson(
      path.join(outputDir, "approval-decision.json"),
    );
    const approved = await readJson(
      path.join(outputDir, "approved-proposal.json"),
    );

    assert.equal(decision.decision_reason, decisionReason);
    assert.equal(approved.decision_reason, decisionReason);
  });
});

async function assertDecisionWithoutApprovedProposal(decision) {
  await withTempDir(async (tempDir) => {
    const rankedProposalsPath = await writeRankedProposals(tempDir);
    const result = runRecorder({
      tempDir,
      rankedProposalsPath,
      env: {
        DECISION: decision,
      },
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);

    const outputDir = outputPath(tempDir);
    assert.deepEqual(await readdir(outputDir), ["approval-decision.json"]);

    const decisionRecord = await readJson(
      path.join(outputDir, "approval-decision.json"),
    );

    assert.equal(decisionRecord.proposal_id, "proposal-001");
    assert.equal(decisionRecord.decision, decision);
    assert.equal(
      await pathExists(path.join(outputDir, "approved-proposal.json")),
      false,
    );
  });
}

function runRecorder({ tempDir, rankedProposalsPath, env = {} }) {
  return spawnSync(process.execPath, [SCRIPT_PATH, rankedProposalsPath], {
    cwd: tempDir,
    env: {
      ...process.env,
      SOURCE_RUN_ID: "run-123",
      PROPOSAL_ID: "proposal-001",
      DECISION: "approve",
      DECISION_REASON: "Looks safe.",
      GITHUB_ACTOR: "approver",
      ...env,
    },
    encoding: "utf8",
  });
}

async function writeRankedProposals(tempDir) {
  const sourceDir = path.join(tempDir, "source-audit");
  const rankedProposalsPath = path.join(sourceDir, "ranked-proposals.json");

  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    rankedProposalsPath,
    `${JSON.stringify(
      {
        proposals: [
          {
            proposal_id: "proposal-001",
            category: "SEO",
            recommended_action: "Review source-backed page evidence.",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return rankedProposalsPath;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function outputPath(tempDir) {
  return path.join(tempDir, "out", "proposal-decision");
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function withTempDir(callback) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "proposal-decision-"));

  try {
    await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
