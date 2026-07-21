#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
bundle_dir="${repo_root}/out/audit-bundle"

node "${script_dir}/collect-search-console-search-analytics.mjs" "${bundle_dir}"
node "${script_dir}/collect-search-console-url-inspection.mjs" "${bundle_dir}"
node "${script_dir}/collect-google-analytics-data.mjs" "${bundle_dir}"
node "${script_dir}/collect-search-console-sitemaps.mjs" "${bundle_dir}"
node "${script_dir}/collect-site-crawl.mjs" "${bundle_dir}"

printf 'Created audit bundle at %s\n' "${bundle_dir}"
