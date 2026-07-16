# X Operations

This directory stores source-aware X operations for Japan Remote Guide.

## Directory Map

- `drafts/` stores post candidates that passed source, duplicate, CTA, hashtag, length, brand, and site-route checks.
- `logs/` stores article-monitor run logs, including held updates.
- `sources/` stores source records for each post candidate.
- `history/` stores posts that were actually published, with `postedAt` and, when available, `postId`.
- `archive/` stores older posts that should still be searchable for duplication review.
- `analytics/raw/` stores raw X metric exports for published posts.
- `analytics/` stores 24-hour, 7-day, and 30-day metric analysis.
- `reports/` stores improvement reports based on analytics.
- `state/` stores the last processed Git commit for article monitoring.

## Commands

Generate drafts after article updates:

```powershell
node scripts/x-content-ops.mjs
```

Review a specific Git range without changing state:

```powershell
node scripts/x-content-ops.mjs --since HEAD~1 --until HEAD --dry-run --no-update-state
```

Create analytics and improvement reports after metrics are available:

```powershell
node scripts/x-analytics-report.mjs
```

Raw metric files should be JSON in `x/analytics/raw/` and include:

```json
{
  "impressions": 0,
  "engagements": 0,
  "likes": 0,
  "reposts": 0,
  "replies": 0,
  "bookmarks": 0,
  "linkClicks": 0,
  "profileClicks": 0,
  "follows": 0
}
```

## Quality Rule

If official or primary sources cannot be recognized and reached, the monitor writes a hold reason to `x/logs/` instead of saving a post candidate to `x/drafts/`.
