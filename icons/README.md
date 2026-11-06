# Icon sources

`confluence-mark.svg` is the official Confluence app icon from Atlassian:
https://atlassian.design/assets/d7aacc201c59/logos/confluence_app.zip

The Confluence glyph is combined with the existing JiraLog icon's background and LOG banner to match the companion extension. `icon.png` is the full-resolution source; icon16/32/48/128.png are the extension variants.

To rebuild on Windows with PowerShell 7, run `./tools/build-icons.ps1` from this repository. It expects the companion `../JiraLog/icons/icon.png` source to be present.
