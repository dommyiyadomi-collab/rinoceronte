#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_DECISIONS = new Set(["approve", "reject", "defer"]);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  const [rankedProposalsPath, proposalId, decision, reason = ""] = process.argv.slice(2);

  if (!rankedProposalsPath || !proposalId || !decision) {
    fail(
      "Usage: node scripts/record-proposal-decision.mjs <ranked-proposals.json> <proposal_id> <approve|reject|defer> [reason]",
    );
    return;
  }

  if (!ALLOWED_DECISIONS.has(decision)) {
    fail(`Invalid decision: ${decision}. Expected approve, reject, or defer.`);
    return;
  }

  let ranked;
  try {
    ranked = JSON.parse(await readFile(rankedProposalsPath, "utf8"));
  } catch (error) {
    fail(`Could not read valid JSON from ${rankedProposalsPath}: ${error.message}`);
    return;
  }

  if (!ranked || !Array.isArray(ranked.proposals)) {
    fail("ranked-proposals.json must contain a proposals array.");
    return;
  }

  const proposal = ranked.proposals.find(
    (candidate) => candidate?.proposal_id === proposalId,
  );

  if (!proposal) {
    fail(`Proposal ${proposalId} was not found in ranked-proposals.json.`);
    return;
  }

  const outputDir = path.resolve("out", "proposal-decision");
  await mkdir(outputDir, { recursive: true });

  const recordedAt = new Date().toISOString();
  const actor = process.env.GITHUB_ACTOR || "unknown";
  const sourceRunId = process.env.SOURCE_RUN_ID || null;

  const decisionRecord = {
    proposal_id: proposalId,
    decision,
    decided_by: actor,
    decided_at: recordedAt,
    decision_reason: reason,
    source_run_id: sourceRunId,
  };

  await writeFile(
    path.join(outputDir, "approval-decision.json"),
    `${JSON.stringify(decisionRecord, null, 2)}\n`,
    "utf8",
  );

  if (decision === "approve") {
    const approvedProposal = {
      ...decisionRecord,
      proposal,
    };

    await writeFile(
      path.join(outputDir, "approved-proposal.json"),
      `${JSON.stringify(approvedProposal, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(
    `Recorded ${decision} decision for ${proposalId} by ${actor}.`,
  );
}

await main();
