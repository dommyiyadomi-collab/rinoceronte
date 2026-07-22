# OpenAI Ranked Proposal Generation

## Purpose

The daily site audit can generate structured proposal candidates after the
completed audit bundle has been collected. This stage reads the existing
`out/audit-bundle/audit-bundle.json` evidence file and sends it to the OpenAI
Responses API to produce `ranked-proposals.json`.

This stage only generates proposal candidates. It does not approve proposals,
implement changes, invoke Codex, dispatch implementation workflows, or modify
production website files.

## Workflow Position

The daily audit remains separated into these stages:

1. audit collection
2. proposal generation
3. approval
4. implementation

This PR implements only stage 2. The proposal-generation job depends on the
audit collection job, downloads the `audit-bundle` artifact, reads
`audit-bundle.json`, and uploads proposal outputs as a separate artifact.

## Responses API

The generator calls:

```text
POST https://api.openai.com/v1/responses
```

The request uses:

- `model` from `OPENAI_AUDIT_PROPOSAL_MODEL`
- `background: true`
- a system instruction that limits the model to the supplied audit evidence
- the raw `audit-bundle.json` content as user input
- `text.format.type: "json_schema"`
- `text.format.name: "daily_audit_proposals"`
- `text.format.strict: true`

The system instruction requires the model to avoid unsupported facts, fabricated
metrics, repository changes, source-code generation, workflow dispatch, and
implementation work. When no evidence-supported proposal can be produced, the
model must return an empty `proposals` array.

## Polling And Cancellation

After creating a background response, the script preserves the returned response
ID and polls:

```text
GET /v1/responses/{response_id}
```

Polling continues while the response status is `queued` or `in_progress`. The
script does not wait indefinitely.

Technical timeout controls:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `OPENAI_AUDIT_PROPOSAL_POLL_INTERVAL_MS` | `5000` | Delay between polling requests. |
| `OPENAI_AUDIT_PROPOSAL_TIMEOUT_MS` | `600000` | Maximum total polling time before cancellation. |

The defaults are operational timeout controls only. They are not scoring,
ranking, or business-priority policy.

When the configured timeout is reached, the script attempts:

```text
POST /v1/responses/{response_id}/cancel
```

The metadata records whether cancellation was attempted and the non-sensitive
result of that request.

## Structured Output Schema

The generator requests this strict JSON Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["generated_at", "site_stack", "proposals"],
  "properties": {
    "generated_at": {
      "type": "string"
    },
    "site_stack": {
      "type": "string"
    },
    "proposals": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "proposal_id",
          "category",
          "evidence",
          "impact_score",
          "implementation_cost_score",
          "risk_score",
          "test_ease_score",
          "overall_priority",
          "recommended_action"
        ],
        "properties": {
          "proposal_id": {
            "type": "string"
          },
          "category": {
            "type": "string",
            "enum": [
              "UX",
              "SEO",
              "performance",
              "security",
              "content",
              "monetization"
            ]
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "impact_score": {
            "type": "number"
          },
          "implementation_cost_score": {
            "type": "number"
          },
          "risk_score": {
            "type": "number"
          },
          "test_ease_score": {
            "type": "number"
          },
          "overall_priority": {
            "type": "string"
          },
          "recommended_action": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

Before writing `ranked-proposals.json`, the script parses the completed response
output and validates it against the same schema. Additional top-level fields and
additional proposal fields are rejected.

## Scoring Boundary

The output includes:

- `impact_score`
- `implementation_cost_score`
- `risk_score`
- `test_ease_score`
- `overall_priority`

The generator does not hard-code a priority weighting formula, does not combine
those scores mathematically, and does not sort proposals through a newly invented
numeric rule. It preserves the proposal order returned by the strict structured
response.

## Required Configuration

| Name | Required | Purpose |
| --- | --- | --- |
| `OPENAI_ACCESS_TOKEN` | Yes | GitHub Actions secret used as the bearer token for the Responses API. |
| `OPENAI_AUDIT_PROPOSAL_MODEL` | Yes | Repository variable selecting the proposal-generation model. |
| `OPENAI_AUDIT_PROPOSAL_POLL_INTERVAL_MS` | No | Optional polling interval override. |
| `OPENAI_AUDIT_PROPOSAL_TIMEOUT_MS` | No | Optional total polling timeout override. |

The script fails before making an API request when `OPENAI_ACCESS_TOKEN` or
`OPENAI_AUDIT_PROPOSAL_MODEL` is missing. The token is never committed, printed,
stored in output JSON, copied into examples, or written into artifacts.

## Output Files

The proposal-generation stage writes:

```text
out/audit-bundle/ranked-proposals.json
out/audit-bundle/openai-proposal-response-metadata.json
```

It reads but does not modify:

```text
out/audit-bundle/audit-bundle.json
```

The metadata file records non-sensitive auditability details, including:

- generation timestamp
- response ID
- model
- response status
- creation and completion timestamps when returned
- polling interval, timeout, and attempts
- timeout status
- cancellation status
- non-sensitive request errors
- non-sensitive response errors

It does not store the API token, Authorization header, or unrelated environment
values.

## Artifact Storage

The existing `audit-bundle` artifact is preserved by the audit collection job.
The proposal-generation job uploads a separate `ranked-proposals` artifact with:

- `audit-bundle.json`
- `ranked-proposals.json`
- `openai-proposal-response-metadata.json`

Generated proposal JSON is not committed to the repository.

## Failure Behavior

If `audit-bundle.json` is missing or invalid, the script does not call the
Responses API and records a machine-readable metadata error when possible.

If OpenAI configuration is missing or invalid, the script does not call the
Responses API and records a machine-readable metadata error without exposing
secrets.

If response creation fails, the script records the non-sensitive HTTP status and
safe response body where available, and does not fabricate
`ranked-proposals.json`.

If polling times out, the script attempts cancellation, preserves the response
ID and timeout metadata, and fails the job.

If the completed structured output is missing, invalid JSON, or violates the
schema, the script records the validation failure and does not write a successful
`ranked-proposals.json`.

## Security Boundary

This stage does not:

- approve proposals
- implement proposals
- invoke Codex
- use `openai/codex-action`
- call `codex exec`
- dispatch GitHub workflows
- request `contents: write`
- request `pull-requests: write`
- modify `public/`
- modify website content or design
