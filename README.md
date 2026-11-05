# ConfluenceLog

A Microsoft Edge / Chromium extension that provides a personal overview for Confluence in the browser popup.

## Current version (1.0.0)

- Manifest V3 browser extension, based on the JiraLog project structure and visual language
- Confluence Cloud login using host URL, Atlassian email and API token
- Host permission is requested only for the configured origin
- Personal comment categories: **My comments** (threads you started), **Involved** (threads you replied to or were mentioned in)
- Inline and page comments with Open/Done views based on the returned `resolutionStatus`
- Search by page title and comment text
- Opens the relevant Confluence page from each result
- Light/dark theme and German/English UI
- Local browser storage; no external backend or analytics

## Install locally in Microsoft Edge

1. Extract the ZIP file to a local folder.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted `ConfluenceLog` folder.
5. Open the extension, select Settings and enter your Confluence Cloud host, Atlassian email and API token.
6. Enter your credentials and select **Connect and save**. Approve the requested host permission when Edge asks for it.

When disconnected, only the login form is shown. After a successful login, the comment overview and settings become available. Credentials are revalidated during synchronization; reopening a fresh cache does not trigger another API scan.

Enter only your Atlassian company name in the host field (for example, `example` for `https://example.atlassian.net`).

## API token

Create an Atlassian API token in your Atlassian account security settings. The extension uses HTTP Basic authentication against the Confluence Cloud REST API. The permission request is triggered directly by the login-button interaction. It first verifies the credentials with `GET /wiki/rest/api/user/current` and then reads comments and pages through REST API v2.

## Permissions and data handling

- `storage`: saves credentials, cached comments and metadata locally; session storage retains filters, expanded conversations and the comment-page scroll position.
- `alarms`: schedules background synchronization every five minutes while the browser is running.
- Optional host permission: requested only for the configured Confluence origin.
- The API token is stored in `chrome.storage.local` in the browser profile. This is local storage, **not encrypted secret storage**. Anyone with access to the same browser profile may potentially access it. Do not use this extension on a shared/untrusted browser profile.
- API requests are sent only to the configured Confluence host. No external backend, telemetry or analytics are used. The optional search Easter egg loads the same GIF from `i.gifer.com` as JiraLog, without a referrer, only when its trigger phrase is entered.
- Results are limited by the permissions of the configured Atlassian account. The API only returns content that account can access.

## Comment inbox

The popup shows threads containing your own comments or explicit mentions of your account, including replies. Filter by My comments (threads you started), Involved (threads you replied to or were mentioned in), or Done; search across page titles and the entire conversation. Both inline and page/footer comments are included. Filter by All types, Inline or Page. My comments is the default view; the Done view shows resolved conversations. Both statuses are fully loaded and cached, including reply history and metadata.

- Entries show the complete original comment, labels and a direct Confluence link.
- When replies exist, expand Replies to read them without repeating the original comment. Filters and expanded conversations survive popup closure within the same browser session.
- The extension is read-only: replying and resolving are performed in Confluence. No comment POST, PUT or DELETE requests are exposed by the popup or background worker.

## API and limitations

Uses the [Confluence Cloud comment REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/), with paginated global inline and footer comment collections and parent reconstruction. If a global collection returns HTTP 404, the extension falls back to paginated page comment collections and recursively loads replies. Original authors of edited comments are retrieved from version 1, with a content-history fallback if the old version is unavailable. Page metadata is loaded for relevant threads only. Collection requests use `limit=250` to reduce pagination calls; cursor links returned by Confluence are followed unchanged. Requests use at most five concurrent workers per collection.

Results are limited to content accessible to the signed-in account. An API failure is displayed with its API path on the comment page; previously loaded results remain available. Inaccessible individual comments or authors produce an incomplete-results notice. Connection messages stay on the settings page; loading stays inside the comment list. Large tenants may take longer to load. Mention detection uses explicit ADF account IDs or storage-format mention attributes, rather than matching names in text.

A background service worker refreshes the cache about every five minutes, including while the popup is closed. Browser sleep or shutdown may delay updates. The popup immediately shows the last saved comments and their update timestamp; opening it does not refetch a fresh cache. The refresh button forces synchronization. Offline errors retain the last successful snapshot; HTTP 401 invalidates it.

Refreshes still enumerate the current open comment collections to discover new replies, deletions and resolution changes; there is no reliable delta feed. Original-author lookups are reused across refreshes, and page/user metadata is refreshed at most hourly. Overlapping refresh requests are deduplicated. If one comment collection fails, its last successful cached conversations are retained with an incomplete-results note. Cache writes are scoped to the configured host and account and rejected if credentials change during a request. Cached comment text remains in local browser storage.

## Development

No build step or third-party dependencies. Run `node --check popup.js`, `node --check confluence.js`, `node --check background.js` and `node --test tests/*.test.cjs`.

Comment providers in `confluence.js` isolate collection loading from the shared inbox, settings and presentation. Additional providers can introduce tasks or notifications later without changing the connection settings.

Live authentication, tenant permissions, and deep-link navigation should also be checked with a real Confluence Cloud account after loading the unpacked extension.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Created by Alexander Karge. The project follows the structure and UI conventions of JiraLog.

Initial loading and background refresh include both open and resolved conversations. The page fallback requests open/reopened/resolved/dangling inline roots and traverses replies for all statuses. Switching to Done uses the same cache and does not trigger another scan. The open count always excludes resolved conversations.

Done is sorted by `resolutionLastModifiedAt` or `resolutionLastModifiedTime`, newest first. Entries without a valid resolution timestamp come last, ordered by conversation activity. The resolution timestamp is also shown on resolved entries when available.

Resolved entries show the person identified by `resolutionLastModifierId` when supplied by Confluence. Their display name is resolved through the same cached user lookup used for comment authors; if unavailable, the account ID is shown.
