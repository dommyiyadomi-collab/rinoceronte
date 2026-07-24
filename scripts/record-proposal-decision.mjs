#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_DECISIONS = new Set(["approve", "reject", "defer"]);
const REQUIRED_ENV_VARS = [
  "SOURCE_RUN_ID",
  "PROPOSAL_ID",
  "DECISION",
  "GITHUB_ACTOR",
];
const USAGE =
  "Usage: node scripts/record-proposal-decision.mjs <ranked-proposals.json>; provide SOURCE_RUN_ID, PROPOSAL_ID, DECISION, and GITHUB_ACTOR via environment. DECISION_REASON is optional.";

export class ProposalDecisionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProposalDecisionError";
  }
}

function requireEnv(env, name) {
  const value = env[name];

  if (value === undefined || String(value).trim() === "") {
    throw new ProposalDecisionError(
      `Missing required environment variable: ${name}.`,
    );
  }

  return value;
}

function readDecisionEnv(env) {
  for (const name of REQUIRED_ENV_VARS) {
    requireEnv(env, name);
  }

  const sourceRunId = env.SOURCE_RUN_ID;
  const proposalId = env.PROPOSAL_ID;
  const decision = env.DECISION;

  if (!ALLOWED_DECISIONS.has(decision)) {
    throw new ProposalDecisionError(
      `Invalid decision: ${decision}. Expected approve, reject, or defer.`,
    );
  }

  return {
    sourceRunId,
    proposalId,
    decision,
    reason: env.DECISION_REASON ?? "",
    actor: env.GITHUB_ACTOR,
  };
}

export async function recordProposalDecision({
  rankedProposalsPath,
  env = process.env,
  now = () => new Date(),
  outputDir = path.resolve("out", "proposal-decision"),
} = {}) {
  if (!rankedProposalsPath) {
    throw new ProposalDecisionError(USAGE);
  }

  const { sourceRunId, proposalId, decision, reason, actor } =
    readDecisionEnv(env);

  let ranked;
  try {
    ranked = JSON.parse(await readFile(rankedProposalsPath, "utf8"));
  } catch (error) {
    throw new ProposalDecisionError(
      `Could not read valid JSON from ${rankedProposalsPath}: ${error.message}`,
    );
  }

  if (!ranked || !Array.isArray(ranked.proposals)) {
    throw new ProposalDecisionError(
      "ranked-proposals.json must contain a proposals array.",
    );
  }

  const proposal = ranked.proposals.find(
    (candidate) => candidate?.proposal_id === proposalId,
  );

  if (!proposal) {
    throw new ProposalDecisionError(
      `Proposal ${proposalId} was not found in ranked-proposals.json.`,
    );
  }

  await mkdir(outputDir, { recursive: true });

  const decisionRecord = {
    proposal_id: proposalId,
    decision,
    decided_by: actor,
    decided_at: now().toISOString(),
    decision_reason: reason,
    source_run_id: sourceRunId,
  };

  await writeFile(
    path.join(outputDir, "approval-decision.json"),
    `${JSON.stringify(decisionRecord, null, 2)}\n`,
    "utf8",
  );

  const approvedProposalPath = path.join(outputDir, "approved-proposal.json");
  await rm(approvedProposalPath, { force: true });

  if (decision === "approve") {
    const approvedProposal = {
      ...decisionRecord,
      proposal,
    };

    await writeFile(
      approvedProposalPath,
      `${JSON.stringify(approvedProposal, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    decisionRecord,
    approved: decision === "approve",
  };
}

export async function main({ argv = process.argv, env = process.env } = {}) {
  const args = argv.slice(2);

  if (args.length !== 1) {
    throw new ProposalDecisionError(USAGE);
  }

  const { decisionRecord } = await recordProposalDecision({
    rankedProposalsPath: args[0],
    env,
  });

  console.log(
    `Recorded ${decisionRecord.decision} decision for ${decisionRecord.proposal_id} by ${decisionRecord.decided_by}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
