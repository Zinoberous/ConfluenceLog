# Instructions for AI contributors

These instructions record the current product rules and decisions as of 2026-11-26. Read this file before changing this repository. Read the relevant implementation and tests before explaining behavior.

## Decision handling

- Later explicit user instructions supersede earlier decisions. Update this file when an accepted requirement changes.
- Preserve requirements outside the requested scope.
- If code, README, or this file disagree, identify the specific conflict. Correct implementation regressions against the current requirements. Ask the user when intent genuinely cannot be resolved.
- Do not describe an automated mock test as a successful live tenant test.
- Keep existing staged and unrelated edits intact. No automatic commits or version bumps. Current version is 1.0.0 unless the user changes it.
- The three sibling repositories are ConfluenceLog, JiraLog, and BitbucketLog. Preserve their common visual language. Settings and About follow the same card layout, spacing, controls, author footer, and icon navigation, with product-specific connection fields.
- Icons use the product logo above the LOG wordmark on the existing shared template.
- Support German, English, and system language, plus light/dark/system themes. Translate new labels, tooltips, accessibility text, and dynamic messages.
- Connection labels are Host (where applicable), Email, and API-Token in German / API token in English. The token label links to https://id.atlassian.com/manage-profile/security/api-tokens in a new tab.
- Settings is the default page only when no saved tab exists. Restore the last chosen page across browser restarts using local storage. Avoid automatic navigation on background refresh or after saving credentials.
- Keep loading messages within the affected page. Notices have an accessible dismiss button and do not immediately reappear on rerender after dismissal. Product-specific exceptions are documented below.
- Footers use entry count on the left where applicable, Updated plus timestamp including seconds on the right, and the small framed continuously rotating glyph. Animation is independent of request state. Honor existing reduced-motion support.
- No backend or analytics. Store credentials and caches locally, never print tokens or put them into URLs. Cache updates must not apply stale results after account changes.
- Use supported public APIs. Notifications require an appropriate official API. Rovo integration is outside the current scope. Do not use undocumented endpoints or browser-session workarounds.
- Use plain JavaScript Manifest V3 and the existing code structure. Avoid unnecessary dependencies/build tooling. Keep code readable and edits scoped.
- Run appropriate syntax checks and `node --test tests/*.test.cjs`. Add regression coverage when fixing a substantive data, persistence, concurrency, or retry issue.

## Product requirements

- Read-only personal comments and assigned tasks overview. Perform replies, resolution, and task editing in Confluence.
- Comment tabs are My comments, Involved, Done. No All tab and no Reply needed category.
- My comments means the original root was authored by the current user.
- Involved means another person authored the root and the current user replied or was mentioned. Own roots are excluded even when their replies contain mentions or own responses.
- Include inline and page/footer comments. Labels are Inline and Seite in German. Load open and resolved conversations initially.
- Determine completion from Confluence's resolutionStatus. No local completion model.
- Cards are compact, with page title above the full original comment, author and timestamp, and a direct comment link above the reply expander.
- Replies expands independently only when replies exist. Show replies alone, without duplicating the original comment or repeating a reply count in the metadata.
- Comment timestamps use dd.MM.yyyy HH:mm in German, without a comma.
- Resolved metadata reads Erledigt: dd.MM.yyyy HH:mm and adds bold von <Name> only when the resolver differs from the root author.
- Done sorts newest resolution first. Missing/invalid resolution timestamps come last, with activity as fallback.
- Tab counts respect the current search/type filtering. The badge counts relevant open threads plus assigned open tasks, with each thread counted once.
- Tasks show only open tasks assigned to the current account, locally rechecking server filters. Page title precedes creator/time and the task text.
- Remove the assignee mention from task text. Omit missing, empty, and whitespace-only text, including tasks emptied by removal of the mention. Retain mentions of other people.
- Tasks sort by due date ascending, undated last, then newest creation first. Today's due date is yellow, overdue red. Preserve the calendar date without UTC shifting.
- Retain filters, reply expansion, page, and separate comment/task scroll positions across restarts. Restore after making the correct page visible so a hidden page's zero position cannot overwrite the saved value.

## Loading and failure behavior

- confluence.js owns API access, normalization, thread building, providers and cache conversion. background.js owns sync lifecycle and badge. popup.js owns UI and view persistence.
- Use limit=250 and follow pagination. If global comment collections return 404, use page collections and traverse children. Recover original authors from version 1/history where needed.
- Reuse original-author lookups and refresh page/user metadata at most hourly.
- Continue chained background synchronization even when popup closes. Recovery alarm is 30 seconds. No overlapping passes or manual reload button.
- Retain last successful provider data on partial failures. HTTP 401 invalidates account data. Retry failures with exponential backoff from 30 seconds to five minutes and honor longer Retry-After for 429/503.
- Saving a successfully verified connection must clear persisted auth/retry blocks even with unchanged credentials. Serialize this reset behind in-flight passes. The reconnect worker action exists for this reason.
- Request browser permission for only the configured host during the save gesture.
- Keep nonfatal overview-completeness details out of the persistent foreground UI.
- JiraLog Easter eggs were explicitly copied here. Preserve existing click thresholds, alternative themes, and user-triggered search GIF behavior.

## Verification

Run node --check for popup.js, confluence.js and background.js, then the full test suite. Tenant permissions and live API availability still require real-account verification.

