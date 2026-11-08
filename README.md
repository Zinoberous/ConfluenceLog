# ConfluenceLog

A Microsoft Edge / Chromium extension that provides a personal overview for Confluence in the browser popup.

## Current version (1.0.0)

- Manifest V3 browser extension, based on the JiraLog project structure and visual language
- Confluence Cloud login using host URL, Atlassian email and API token
- Host permission is requested only for the configured origin
- Personal comment categories: **My comments** (threads you started), **Involved** (threads you replied to or were mentioned in)
- Inline and page comments with Open/Done views based on the returned `resolutionStatus`
- Search by page title and comment text
- Dedicated Tasks page for open tasks assigned to the signed-in account, with optional due dates
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

When disconnected, the popup opens Settings. Once connected, Comments and Tasks become available. The popup restores the last selected page when reopening within the same browser session.

Enter only the subdomain in the Host field (for example, `example` for `https://example.atlassian.net`).

## API token

Create an Atlassian API token in your Atlassian account security settings. The extension uses HTTP Basic authentication against the Confluence Cloud REST API. The permission request is triggered directly by the login-button interaction. It first verifies the credentials with `GET /wiki/rest/api/user/current` and then reads comments and pages through REST API v2.

## Permissions and data handling

- `storage`: saves credentials, cached comments, tasks and metadata locally. Session storage retains the selected page, filters, expanded conversations and separate scroll positions for Comments and Tasks.
- `alarms`: resumes background synchronization if the browser suspends the worker.
- Optional host permission: requested only for the configured Confluence origin.
- The API token is stored in `chrome.storage.local` in the browser profile. This is local storage, **not encrypted secret storage**. Anyone with access to the same browser profile may potentially access it. Do not use this extension on a shared/untrusted browser profile.
- API requests are sent only to the configured Confluence host. No external backend, telemetry or analytics are used. The optional search Easter egg loads the same GIF from `i.gifer.com` as JiraLog, without a referrer, only when its trigger phrase is entered.
- Results are limited by the permissions of the configured Atlassian account. The API only returns content that account can access.

## Comment inbox

The popup shows threads containing your own comments or explicit mentions of your account, including replies. Filter by My comments (threads you started), Involved (threads you replied to or were mentioned in), or Done; search across page titles and the entire conversation. Both inline and page/footer comments are included. Filter by All types, Inline or Page. My comments is the default view; the Done view shows resolved conversations. Both statuses are fully loaded and cached, including reply history and metadata.

- Entries show the complete original comment, labels and a direct Confluence link.
- Done shows resolved conversations, newest resolution first. Entries without a resolution timestamp come last, ordered by activity. When available, the entry shows when it was resolved and who resolved it if that person differs from the original author.
- When replies exist, expand Replies to read them without repeating the original comment. Filters and expanded conversations survive popup closure within the same browser session.
- The extension is read-only: replying and resolving are performed in Confluence. No comment POST, PUT or DELETE requests are exposed by the popup or background worker.

## Assigned tasks

The Tasks navigation item shows open tasks assigned to the connected account. Tasks are fetched through the public [Confluence Cloud task API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-task/) using `status=incomplete`, `assigned-to=<accountId>`, `limit=250` and cursor pagination. Both filters are also checked locally.

Each entry shows the page or blog post title, creator, creation time, task text, optional due date and a link to Confluence. The assignee mention is removed from the displayed text. Tasks with no text left after trimming whitespace are omitted.

Tasks are sorted by due date, earliest first, with undated tasks last. Ties are sorted by creation time, newest first. Due dates retain their calendar date. Today's dates are yellow and overdue dates are red. Search filters task text and page title.

Tasks share the background synchronization loop and local cache. Task search and scroll position are retained separately from the comments page. Failed task refreshes keep the previous task list and show a page-specific error with its last successful timestamp. Task completion and editing remain in Confluence.

Notifications are not implemented: no private or undocumented notifications endpoints will be used. A supported public API is a prerequisite for any future notifications integration.

## API and limitations

Uses the [Confluence Cloud comment REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/), with paginated global inline and footer comment collections and parent reconstruction. If a global collection returns HTTP 404, the extension falls back to paginated page comment collections and recursively loads replies. Original authors of edited comments are retrieved from version 1, with a content-history fallback if the old version is unavailable. Page metadata is loaded for relevant threads only. Collection requests use `limit=250` to reduce pagination calls; cursor links returned by Confluence are followed unchanged. Requests use at most five concurrent workers per collection.

Results are limited to content accessible to the signed-in account. Connection messages appear in Settings and loading stays inside the relevant list. Large tenants may take longer to load. Mention detection uses explicit ADF account IDs or storage-format mention attributes.

A background service worker starts a new synchronization after the previous pass finishes, even with the popup closed. A 30-second recovery alarm resumes the loop after worker suspension. The toolbar badge counts open relevant comment threads and assigned open tasks. Offline errors retain the last successful snapshot. HTTP 401 invalidates it.

Refreshes enumerate open and resolved comments to discover new replies, deletions and resolution changes. Original-author lookups are reused across refreshes, and page and user metadata is refreshed at most hourly. If one comment collection fails, its last successful cached conversations are retained. Cache writes are scoped to the configured host and account and rejected if credentials change during a request.

Failures trigger exponential backoff from 30 seconds up to five minutes. The worker honors longer `Retry-After` delays for HTTP 429 and 503, including after a worker restart. Authentication or permission failures pause automatic updates until credentials or host permissions change.

## Development

No build step or third-party dependencies. Run `node --check popup.js`, `node --check confluence.js`, `node --check background.js` and `node --test tests/*.test.cjs`.

Comment providers in `confluence.js` isolate collection loading from the shared inbox, settings and presentation. Additional providers can introduce tasks or notifications later without changing the connection settings.

Live authentication, tenant permissions, and deep-link navigation should also be checked with a real Confluence Cloud account after loading the unpacked extension.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Created by Alexander Karge. The project follows the structure and UI conventions of JiraLog.

