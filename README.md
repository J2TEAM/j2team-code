# J2TEAM Code

Public issue tracker for **J2TEAM Code**, an Agent Development Environment: a daemon that runs coding agents in git worktrees, with a desktop app, a web UI, a CLI and a mobile app.

The source code is not in this repository. Use it to:

- [Report a bug](../../issues/new?template=bug_report.yml)
- [Request a feature](../../issues/new?template=feature_request.yml)
- [Send feedback](../../issues/new?template=feedback.yml)

From the app, **Help → Report a Problem…** and **Help → Send Feedback…** open these forms with the app version and system details filled in.

Before you post, search the [existing issues](../../issues). Never paste API keys, tokens or other secrets: a debug bundle from the app is redacted, but check it anyway.

## Database server binaries

[`dbservers/`](dbservers/README.md) holds the signed manifest J2TEAM Code's daemon reads to download PostgreSQL, MySQL, Valkey and MongoDB on demand, the scripts that build and verify it, and the workflows that mirror PostgreSQL and build Valkey into this repository's releases (`postgresql-*`, `valkey-*`). MySQL and MongoDB are only linked to their vendors' official downloads.
