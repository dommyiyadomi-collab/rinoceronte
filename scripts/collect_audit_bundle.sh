#!/usr/bin/env bash
set -euo pipefail

readonly REQUIRED_ENV_VARS=(
  "GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON"
  "GOOGLE_SEARCH_CONSOLE_SITE_URL"
)

missing_env_vars=()

for env_var in "${REQUIRED_ENV_VARS[@]}"; do
  if [[ -z "${!env_var:-}" ]]; then
    missing_env_vars+=("${env_var}")
  fi
done

if (( ${#missing_env_vars[@]} > 0 )); then
  {
    echo "Google Search Console authentication is not configured."
    echo "Missing required environment variable(s):"
    for env_var in "${missing_env_vars[@]}"; do
      echo "  - ${env_var}"
    done
    echo
    echo "Add the missing values as GitHub Secrets before collecting the audit bundle."
    echo "See docs/search-console-auth.md for the required secret names."
  } >&2
  exit 1
fi

if ! node <<'NODE'
const raw = process.env.GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON.trim();
try {
  const credentials = JSON.parse(raw);
  const missingFields = ["type", "client_email", "private_key"].filter(
    (field) => !credentials[field],
  );

  if (credentials.type !== "service_account") {
    console.error(
      "GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON must contain a service_account credential.",
    );
    process.exit(1);
  }

  if (missingFields.length > 0) {
    console.error(
      `GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON is missing: ${missingFields.join(", ")}`,
    );
    process.exit(1);
  }
} catch (error) {
  console.error("GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON must be valid JSON.");
  process.exit(1);
}
NODE
then
  echo "Google Search Console authentication cannot be performed." >&2
  exit 1
fi

if [[ "${GOOGLE_SEARCH_CONSOLE_SITE_URL}" != sc-domain:* &&
  "${GOOGLE_SEARCH_CONSOLE_SITE_URL}" != http://* &&
  "${GOOGLE_SEARCH_CONSOLE_SITE_URL}" != https://* ]]; then
  {
    echo "Google Search Console authentication cannot be performed."
    echo "GOOGLE_SEARCH_CONSOLE_SITE_URL must be a Search Console property URL."
    echo "Use a URL-prefix property such as https://example.com/ or a domain property such as sc-domain:example.com."
  } >&2
  exit 1
fi

echo "Google Search Console authentication inputs are present."
echo "Search Console API collection is not implemented in this step."

# TODO: Collect website audit inputs for the AI audit pipeline.
# TODO: Include site files, metadata, and validation outputs needed by future steps.
# TODO: Keep this script free of Search Console API requests, Google Analytics, OpenAI, Codex, and deployment logic.

bundle_dir="audit-bundle"
mkdir -p "$bundle_dir"

cat > "$bundle_dir/README.md" <<'README'
# Audit bundle placeholder

TODO: Replace this placeholder with the collected website audit bundle inputs.
README

printf 'Created placeholder audit bundle at %s\n' "$bundle_dir"
