# Security

## Reporting vulnerabilities

Email **security@rakazo.com** only. Do not open public GitHub issues for security bugs.

Please include:

- Steps to reproduce
- Impact (what an attacker could do)
- Whether the issue is already public

We will acknowledge your report and work on a fix. Please do not file a public issue for unfixed vulnerabilities.

## Other contact

- General support: **support@rakazo.com**
- Maintainer: **elie@rakazo.com**

## Scope

This policy covers the Rakazo self-hosted product in **this repository**.

Out of scope:

- Third-party AI models and their APIs
- Composio, E2B, and other external services
- Operator misconfiguration (exposed secrets, open databases, weak passwords)

## Prompt injection and outbound data

Pages, search results, files, connector data and inbound messages can carry text written to steer a bot into sending your data somewhere. The backend limits where data can go without a person seeing it:

- **Fetching pages.** `web_fetch` sends its whole URL to the site it names. A run may fetch, without asking, sites named in the message you sent, sites approved earlier in the same run, sites you chose "Always allow" for, and the exact URLs a `web_search` returned. Any other site shows an approval card with the full URL. Sites are compared by registrable domain, so `docs.example.com` and `example.com` are one site. Webhook runs have nobody to ask, so they refuse sites that are not always allowed.
- **Web search.** Queries go only to the search provider the deployment configured, not to a site the text chose, so they are not gated.
- **Connector reads.** A read sends its arguments to the connector's server. Once a run has taken in outside content, a read on a connector the run had not already used is treated like a write: your approval rules and Auto Review apply to it. Webhook and other runs you did not start count as outside content from the start.
- **Link icons.** The server fetches an icon only from a link's registrable domain, never its subdomain or path, so a link cannot leak data through DNS or the request when it is rendered.

Known gaps:

- **Shell and browser.** Commands and pages on a bot computer can reach any public host. `SANDBOX_COMPUTER_EGRESS=restricted` (see [self-hosting](docs/self-host.md#restricted-computer-egress)) blocks private networks and cloud metadata, not public hosts. A bot that runs `curl` or opens a page can send data anywhere the computer can reach, and page scripts can too.
- **Open redirects and trusted sites.** Once a site is trusted for a run, any URL on it is allowed, including a redirect on that site to another host.
- **Saved state.** Memory, skills and earlier conversation are treated as yours. Text that an earlier run saved there is not flagged as outside content.

## Supported versions

We support security fixes on the current `main` branch and the latest release (beta).

There is no bug bounty program at this time.
