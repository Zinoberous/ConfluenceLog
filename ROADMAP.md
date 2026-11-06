# Product decisions

- Notifications: excluded unless a supported public API allows the required access. Do not integrate private browser endpoints or depend on undocumented authentication behavior.
- ConfluenceLog tasks: initial read-only page lists open tasks assigned to the current account, with due dates when present. Implemented using the public REST API v2 task resource.
- JiraLog: a separate page for open issues assigned to the current account is planned later. It is outside the current Confluence tasks implementation.
