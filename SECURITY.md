# Security Policy

## Supported Versions

infinite-canvas is in active development. Security fixes are accepted for the
`main` branch and the latest tagged release. Older versions may be handled on a
best-effort basis.

## Reporting a Vulnerability

Please do not open a public issue with exploit details, credentials, private
API keys, proof-of-concept code, or screenshots that reveal sensitive data.

Preferred reporting channels:

1. Use GitHub private vulnerability reporting or a GitHub Security Advisory for
   this repository, if available.
2. If a private GitHub report is not available, email `1844025705@qq.com` with
   the subject `[infinite-canvas security]`.
3. If neither private channel is available, open a public issue that asks for a
   private contact channel and does not include technical exploit details.

Please include:

- Affected version, commit, branch, or deployment mode.
- Clear reproduction steps.
- Impact and attack scenario.
- Any relevant logs, screenshots, or proof of concept, with secrets removed.
- Whether the issue affects local-only usage, hosted deployments, browser
  storage, WebDAV sync, AI provider configuration, or API proxy behavior.

## Scope

### Canvas node plugins

The supported platform policy permits only executable plugins maintained,
reviewed, and published by the project owner. Ordinary users must not be able
to install JavaScript from an arbitrary URL, upload executable plugin code, or
inject a Provider Adapter. The development source still contains a legacy URL
installer; it is an acknowledged pre-release removal task and is not a
supported trust model.

Reports **in scope** include an ordinary user bypassing the owner-published
registry or allowlist, substitution of an owner-published plugin artifact, a
plugin source cache being writable by an unrelated origin, or a shipped plugin
escaping the platform's documented business permissions. Fork maintainers who
deliberately change this policy own the security model of their deployment.

Examples of in-scope reports:

- Cross-site scripting or token exfiltration in the web app.
- Exposure of locally stored API keys or cloud Canvas data caused by project
  code.
- Unsafe file handling, import/export behavior, or WebDAV proxy behavior.
- Authentication, authorization, or access-control flaws in project-managed
  features.
- Supply-chain issues that are exploitable through this repository's shipped
  code or default configuration.

Examples that are usually out of scope:

- Vulnerabilities in third-party AI providers, model APIs, hosting platforms,
  or browser extensions outside this repository.
- Compromise of a user's own API key outside the app.
- Denial-of-service reports that require unrealistic traffic volume or physical
  access to the user's device.
- Missing security headers without a demonstrated exploit path.
- Social engineering, phishing, spam, or account recovery requests.
- Dependency reports without a practical impact on this project.

## Disclosure

The maintainers aim to acknowledge valid reports within 7 days and coordinate a
fix before public disclosure. Response and fix timelines are best effort for
this community project.

Please allow time for investigation and remediation before publishing details.
Credit will be given on request unless you prefer to remain anonymous.
