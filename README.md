# ConfluenceLog

A Microsoft Edge / Chromium extension that provides a personal overview for Confluence in the browser popup.

## Current preview (0.1.7)

- Manifest V3 browser extension, based on the JiraLog project structure and visual language
- Confluence Cloud login using host URL, Atlassian email and API token
- Host permission is requested only for the configured origin
- Personal comment categories: **My comments** (threads you started), **Watching** (threads you replied to or were mentioned in)
- Inline and page/footer comment filters
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

When disconnected, only the login form is shown. After a successful login, the comment overview and settings become available. The extension revalidates stored credentials when the popup is opened.

Enter only your Atlassian company name in the host field (for example, `example` for `https://example.atlassian.net`).

## API token

Create an Atlassian API token in your Atlassian account security settings. The extension uses HTTP Basic authentication against the Confluence Cloud REST API. The permission request is triggered directly by the login-button interaction. It first verifies the credentials with `GET /wiki/rest/api/user/current` and then reads comments and pages through REST API v2.

## Permissions and data handling

- `storage`: saves the extension settings locally.
- Optional host permission: requested only for the configured Confluence origin.
- The API token is stored in `chrome.storage.local` in the browser profile. This is local storage, **not encrypted secret storage**. Anyone with access to the same browser profile may potentially access it. Do not use this extension on a shared/untrusted browser profile.
- Requests are sent only to the configured Confluence host. No external backend, telemetry or analytics are used.
- Results are limited by the permissions of the configured Atlassian account. The API only returns content that account can access.

## Comment inbox

The popup shows threads containing your own comments or explicit mentions of your account, including replies. Filter by All, My comments (threads you started), Watching (threads you replied to or were mentioned in), or Done; search across page titles and the entire conversation. Inline and page comments can be filtered separately.

- Entries start compact with a short preview, labels and the Confluence link. Each entry has two independent expandable sections: Conversation first, then Actions with the reply form and completion action. Both sections retain their open state while filtering within the popup.
- Send a plain-text reply directly from the popup. Reply drafts survive filtering while the popup stays open.
- Resolve or reopen inline threads in Confluence.
- Complete page comments locally in this browser profile. Confluence has no native resolved state for page comments. New replies or edits reopen locally completed threads. Local completion is isolated by host, account, comment type and thread ID.
- Open the focused comment in Confluence.

## API and limitations

Uses the [Confluence Cloud comment REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/), with paginated global inline/footer collections and parent reconstruction. If a global collection returns HTTP 404, the extension falls back to paginated page comment collections and recursively loads replies. Original authors of edited comments are retrieved from version 1, with a content-history fallback if the old version is unavailable. Page metadata is loaded for relevant threads only. Requests use at most five concurrent workers per collection.

Results are limited to content accessible to the signed-in account. An API failure is displayed with its API path on the comment page; a failure in one comment type preserves results from the other type. Inaccessible individual comments or authors produce an incomplete-results notice. Connection messages stay on the settings page; loading stays inside the comment list. Large tenants may take longer to load. Mention detection uses explicit ADF account IDs or storage-format mention attributes, rather than matching names in text.

Sending replies and resolving inline comments require Confluence comment permissions. Errors remain visible beside the affected conversation and reply text is retained. Closing the browser popup discards unsent drafts. No background polling is performed.

## Development

No build step or third-party dependencies. Run `node --check popup.js` and `node --test tests/comments.test.cjs`.

Comment providers in `popup.js` isolate collection loading and mutations from the shared inbox, settings and presentation. Additional providers can introduce tasks or notifications later without changing the connection settings.

Live authentication, tenant permissions, and deep-link navigation should also be checked with a real Confluence Cloud account after loading the unpacked extension.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Created by Alexander Karge. The project follows the structure and UI conventions of JiraLog.
