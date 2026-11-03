# ConfluenceLog

A Microsoft Edge / Chromium extension that provides a personal overview for Confluence in the browser popup.

## Current preview (0.1.7)

- Manifest V3 browser extension, based on the JiraLog project structure and visual language
- Confluence Cloud login using host URL, Atlassian email and API token
- Host permission is requested only for the configured origin
- Personal comment categories: **My comments**, **Mentions**, **Needs reply**
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

## Important limitations of this preview

- Confluence's REST API returns comment collections with cursor pagination. This version reads the global inline/footer comment collections and the accessible current pages.
- Inline comments have a resolution state; footer/page comments do not. Therefore page-comment reply status is inferred from the available conversation history, not from a native resolved flag.
- `Needs reply` is a heuristic: a thread is considered relevant when you participated or were mentioned and the latest comment was written by someone else. It is a reminder, not a definitive workflow state.
- Mention detection relies on account IDs in Atlassian Document Format (ADF). Depending on the tenant/API payload, mention metadata may be incomplete.
- The API's global comment endpoints and page metadata can vary with tenant settings and permissions. Test against your tenant before relying on the result as a complete audit list.
- The popup currently shows root comments and a preview of the latest reply; it does not provide a full conversation editor or mark-as-read workflow.

## Development notes

No build step or third-party JavaScript dependencies are required. The extension uses plain HTML, CSS and JavaScript to keep local installation simple.

## Roadmap

- Full thread view and direct deep links to inline anchors
- More precise reply-state handling and user-controlled triage
- Tasks / action items
- Recently updated pages
- Pages not updated for a configurable period
- Activity overview
- Export and configurable refresh

## License

MIT. See [LICENSE](LICENSE).

## Credits

Created by Alexander Karge. The project follows the structure and UI conventions of JiraLog.
