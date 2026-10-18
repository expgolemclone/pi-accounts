Based on [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions).

# 🔐 pi-accounts — Switch Between Provider Accounts

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Save and switch named OAuth and API key accounts for Pi's built-in login providers.
Shares the OpenAI selection across processes using the same Pi agent directory. Other providers keep independent session selections. Choosing `default` restores Pi's normal authentication without deleting saved accounts.

> [!WARNING]
> Anthropic currently treats Claude Pro/Max use through third-party harnesses as **extra usage billed per token**, rather than consumption of the normal plan allowance.
> Review your Anthropic billing and extra-usage settings before using a named Anthropic account.

> [!CAUTION]
> Named credentials are stored locally in a private file. API key entry uses visible, unmasked TUI/RPC input; use trusted clients and avoid screen sharing or recording.

## ✨ Features

- Manages named OAuth accounts for every built-in `/login` provider: Anthropic, GitHub Copilot, Kimi For Coding, Meta, OpenAI, OpenAI Codex (legacy), OpenRouter, Radius, and xAI.
- Saves named API key accounts for the same providers except OAuth-only OpenAI Codex (legacy).
- Shares OpenAI account changes before each next request, including tool continuations and compaction, without `/reload`.
- Coordinates quota recovery with a fresh, isolated Pi ping/pong probe before publishing a replacement.
- Keeps other providers' session selections, saved startup defaults, and `PI_ACCOUNT` override behavior.
- Applies provider-specific credentials, endpoints, headers, and model availability through Pi's built-in providers.
- Refreshes rotating credentials and verifies the effective authentication before reporting success.
- Starts sessions without waiting for routine account selection or provider activation, while gating each provider's first use on verified authentication.
- Offers only the verified active OAuth credential to compatible in-process consumers.
- Writes credentials atomically to a private local file and fails closed for only the affected provider when activation fails.
- Imports legacy `pi-codex-accounts.json` data while retaining the source file for rollback.

## 🚀 Quick start

Run `/accounts` in TUI or RPC mode.
Log in to save a named account, then choose **Set default account → provider → account** to use it when starting a new Pi session.
Use **Switch … account** to change the shared OpenAI selection or another provider's current-session selection.
Unset `PI_ACCOUNT` for OpenAI. For other providers, `PI_ACCOUNT=work pi` selects that name process-locally; a provider without it fails closed.

Routine account selection and provider activation continue in the background after Pi starts.
The first prompt, model switch, or `/accounts` operation that needs a provider waits for its current selection and authentication to finish; activation failures still fail that provider closed before a request is sent.

## 🔌 Supported providers

| Provider | Provider ID | Account-specific behavior |
| --- | --- | --- |
| OpenAI | `openai` | Pi's current ChatGPT subscription OAuth or OpenAI API keys, using the native Responses provider |
| OpenAI Codex (legacy) | `openai-codex` | ChatGPT Plus/Pro OAuth, OAuth-only native-provider bridge, and Codex WebSocket invalidation |
| Meta | `meta` | Muse subscription device login with provider-owned API key minting and renewal, or Meta API keys |
| Anthropic | `anthropic` | Claude Pro/Max OAuth without interfering with Anthropic API-key auth after returning to `default` |
| GitHub Copilot | `github-copilot` | Individual or Enterprise login, credential-derived API endpoint, and account-specific available models |
| Kimi For Coding | `kimi-coding` | Kimi Code subscription OAuth with provider-owned Bearer-header authentication |
| OpenRouter | `openrouter` | OAuth that mints a persistent account API key, or manually entered OpenRouter API keys |
| Radius | `radius` | Gateway-bound OAuth with credential-specific dynamic model-catalog refresh and selected-model rebinding |
| xAI | `xai` | SuperGrok or X Premium OAuth with the native xAI provider and model catalog |

## 💬 Commands

Run `/accounts` to log in with OAuth, add an API key account, switch accounts, set other providers' new-session defaults, or remove saved accounts in TUI or RPC mode.
Arguments are ignored for compatibility; print and JSON modes provide no account-manager output.
Login uses Pi's native OAuth flow, including device codes and cancellation, with equivalent RPC dialogs.

Choose **Add API key account**, select a provider, name the account, and enter its key.
Blank keys and keys containing whitespace or terminal controls are rejected; `!command` expressions are not resolved by named profiles.

`default` is reserved for Pi's built-in login.
Switching changes account identity, not the model. OpenAI changes are shared; other providers' switches remain session-local.
Replacing an existing provider/account name or removing an account requires confirmation.
Removing the shared active OpenAI profile selects built-in login for everyone. For other providers, removal returns this session to `default`; other sessions using the removed profile fail closed.

## ⚙️ Settings

For providers other than OpenAI, open `/accounts` → **Set default account**, choose a provider, then select a saved account or **Pi built-in login**.
The picker shows the saved default and saves your selection immediately; leaving it before selecting changes nothing.

The following startup-default and session-precedence rules apply to providers other than OpenAI; [Shared OpenAI selection](#shared-openai-selection) replaces them for OpenAI.

Defaults are user-wide settings in `<getAgentDir()>/pi-accounts.json` (normally `~/.pi/agent/pi-accounts.json`); project overrides are not supported.
The existing `providers.<provider-id>.active` field stores the saved account name, so previous values remain compatible without migration.
An absent or `null` value means Pi's built-in login; named values must match a saved account under that provider.
The menu clears `active` when you choose **Pi built-in login** or remove the configured default account. Editing a saved default while `PI_ACCOUNT` is set does not change that process's effective selection.

New sessions, including `/new`, forks, and clones, snapshot these defaults.
A session's saved selection takes precedence on restart, resume, and `/reload`; changing a default never switches that session or other existing sessions.
Login and **Switch … account** still change only the current session, not the startup default.

For providers other than OpenAI, `PI_ACCOUNT=<name>` takes precedence over both saved defaults and session selections, including on resume and `/reload`. OpenAI fails closed while this override is set, rather than silently opting out of synchronization.
It is read when a session starts and remains fixed for that session; changing the process environment afterward affects only subsequently started sessions.
The value must be a saved account name: 1–64 letters, numbers, dots, underscores, or hyphens (surrounding whitespace is trimmed); `default` is reserved and invalid.
A missing name for **any supported provider when used**, or an invalid value, fails that provider closed rather than using a default or an existing session choice. Providers not managed by this package remain unchanged.
Unset `PI_ACCOUNT` and restart Pi to restore the session's saved selection. The override does not change saved default-selection fields or record its value in session entries; routine session initialization can still snapshot defaults, and OAuth refresh can update credentials in `pi-accounts.json`.
If a saved session selection is invalid or cannot be written, a valid `PI_ACCOUNT` can still authenticate without repairing that underlying error; unset it and restart Pi to recover through `/accounts`.
`/accounts` and the account status indicate the environment as the effective source without echoing raw environment input. While it is set, interactive switching is unavailable; login can save an account but does not replace the override, and removing its selected credential fails that provider closed immediately.

Sessions predating session-local selection support snapshot the current default once because their historical choice cannot be inferred.
If a manually configured default names a missing account, affected sessions fail closed until you choose an available account or Pi's built-in login.

Saves preserve unknown settings fields and use the credential store's cross-process lock and private atomic replacement.
Within one store, asynchronous reads follow queued writes; failed writes leave the queue usable.
Malformed settings block saves instead of being replaced, and failed saves do not change the session's authentication.

### Shared OpenAI selection

The existing `<getAgentDir()>/pi-accounts.json` owns `providers.openai.sharedSelection` and mirrors its account in `active`. First initialization retains a valid saved default; otherwise it draws uniformly from saved OAuth profiles. Later sessions join that choice. An explicit built-in selection is not a new random draw. Resume, reload, forks and old session snapshots cannot restore an obsolete OpenAI choice.

Each request captures verified authentication. A later switch affects the following request, not inference already in flight. Failed activation stops the request rather than silently choosing another identity.

A native `subscription_sharing_usage_limit_exceeded` error, or the complete native sentence beginning `The ChatGPT user has reached their Subscription Sharing usage limit.`, starts bounded recovery for the captured OAuth profile. The extension does not infer a reset time or impose an account cooldown. Generic throttling, authentication and transport errors do not count. Structured conflicting codes and statuses take precedence, including SSE codes the SDK would otherwise discard.

One representative per recovery round starts a fresh headless Pi with the failed request's model and a minimal ping/pong exchange. It has no tools, conversation history, workspace instructions or unrelated extensions. Successful terminal inference with exactly `pong` is required before publication. Each affected active session then receives literal `continue` once through Pi's normal actionable boundary; idle sessions receive nothing. Completed tool results remain in context, but a model can still choose to repeat an action.

Each round skips the failed account and probes every other saved OAuth candidate at most once, stopping at the first verified success. Other probe failures stop recovery with a credential-free failure summary. Each active user run permits only one recovery round, so a quota error after automatic `continue` stops instead of cycling accounts. Manual switching, abort, shutdown, replacement or intervening work cancel automatic continuation. There is no background retry. A new user request, including a manually typed `continue`, reaches OpenAI normally and may start a fresh round after a stopped round; concurrent and late failures share the applicable round. Manual `/accounts` selection is never blocked by an earlier quota error. Probes consume normal inference usage and do not bypass provider limits. See [OpenAI's error guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

Credential-free coordination records live in `<getAgentDir()>/extensions/accounts/recovery.json`. Preserve this file when updating the installed runtime, and never commit it. Old `cooldowns.json` files are ignored and need no manual edits. Account credentials remain in `pi-accounts.json`.

## 🔌 Extension account protocols

Trusted extensions can use Pi's in-process `pi.events` API to discover named accounts,
activate one for the current session, and request a verified active OAuth credential.
Topology and activation replies contain account identifiers, never credential material;
the separate OAuth credential offer **does** contain secrets. No package import or
credential-file read is needed. See the repository's [Named Account Protocols v1](https://github.com/narumiruna/pi-extensions/blob/main/docs/api/accounts-v1.md)
for topology and activation; it links to the separate OAuth readiness and credential-source
specifications. These references describe payloads, reply timing, cancellation, and consumer safety.

OpenAI protocol activation changes the shared selection. Other providers' activation does not change the user-wide default. When `PI_ACCOUNT` is set, protocol activation
(including restoration of Pi auth) returns `activation_failed` without changing the selection.
Otherwise, activation may persist a session selection even if authentication later fails or the
requester cancels, leaving that provider fail-closed.
Consumers must bound their wait: a missing reply or timeout is not proof that activation
did not happen, and dependent work must not proceed without confirmation. `pi.events`
is not a trust boundary; load only trusted extensions.

## 🔒 Security and privacy

The extension refreshes each selected OAuth account through the provider's `refresh()` implementation and converts it through `toAuth()`.
Named API key accounts use their saved key directly, without OAuth refresh or conversion, and never publish an OAuth credential offer.
It applies the returned API key, headers, and endpoint, then verifies the effective runtime state before reporting success.

If refresh, conversion, provider overlay, or verification fails, the extension installs a non-secret failing runtime credential and aborts turns for that provider.
It does not silently fall back to Pi's built-in login or an environment API key. Only the verified OpenAI quota-recovery flow may choose another named account automatically.
Other providers remain independent and usable.
Selecting `default` removes the package-owned runtime override and restores the exact provider registration that existed before activation.
Pi's built-in credentials are never deleted.

For named accounts that resolve to an API key, the extension also verifies authentication for every available provider model.
A conflicting provider or model authentication header fails that provider closed, even if the conflicting model is not selected.
The extension does not rewrite these settings: remove the conflicting configured header or choose `default` from `/accounts` to recover.
Unrelated headers and native headers that resolve to the selected credential remain supported.

Other providers' session selections are stored as versioned, non-model custom entries in Pi's session JSONL. OpenAI entries are compatibility snapshots, not selection authority.
The entries contain only provider IDs and account names, not OAuth credentials.
The owning Pi session ID prevents a fork or clone from treating copied parent entries as its own selection.
Resume and reload restore entries owned by the same session, while `/tree` navigation keeps one session-wide selection instead of changing authentication by branch.
A malformed matching selection entry fails managed providers closed until `/accounts` writes a valid snapshot; recovery defaults any other managed provider whose selection could not be trusted.

The extension implements the versioned `oauth:credential-source:v1` protocol for compatible current-account consumers such as usage reporters.
It offers a fresh in-memory clone only after the named OAuth credential has produced and verified active runtime authentication for the exact Pi session.
Pending, default, stale, failed, replaced, reloaded, and shut-down states offer nothing.
Compatible consumers can use the extension-neutral `oauth:credential-readiness:v1` protocol to await the required session-owned activation before requesting an offer.
The protocols do not persist or log the offer, which contains neither the account name nor extension identity.
Consumers must match its access token and provider metadata against freshly resolved runtime authentication.
Without a compatible consumer, account activation works unchanged and no credential is requested.

Pi extensions run with the user's process privileges; `pi.events` does not isolate installed extensions.
Install only trusted extensions because any extension can read user files and process memory.
The protocol reduces accidental credential coupling; it is not a sandbox.

GitHub Copilot's `availableModelIds` are projected into the active provider model list.
Switching Copilot accounts rebuilds the projection from the complete pre-overlay model catalog.
A currently selected model that is unavailable to the named account is rejected before the turn starts.

Kimi's provider-owned OAuth returns an `Authorization: Bearer` header instead of an API key.
The extension applies that header and installs a non-secret runtime selector to displace Pi's default Kimi credential.
Activation verifies the effective Bearer header and fails closed before a turn if Pi does not retain it.

OpenRouter's provider-owned OAuth returns a persistent API key represented as an OAuth credential with an empty refresh token.
The extension preserves that exact provider credential separately from manually entered API key accounts.

OpenAI (`openai`) and OpenAI Codex (legacy, `openai-codex`) have independent accounts; credentials are not copied between them. Only `openai` uses shared selection and automatic quota recovery.
Meta's provider renews minted API keys using the saved identity token; an expired identity session requires a new named OAuth login.

Radius OAuth is bound to the active `radius` provider's configured gateway.
The extension refreshes Radius's dynamic model catalog when the session or effective named credential changes, rebinds a retained selected model to its refreshed endpoint, and fails closed if the selected model disappears or catalog publication fails.
Selecting `default` refreshes the Radius catalog against Pi's restored credential after a named account was active.
Shutdown removes named Radius authentication and makes a bounded attempt to restore the default catalog; Pi's next catalog refresh remains the recovery path if the gateway is unavailable during shutdown.
Custom gateways configured for the `radius` provider ID are supported, while arbitrary Radius provider aliases are not.

## 🗄️ Storage and migration

The canonical file is:

```text
~/.pi/agent/pi-accounts.json
```

When `PI_CODING_AGENT_DIR` is set, the file is stored at `$PI_CODING_AGENT_DIR/pi-accounts.json` instead.
Its versioned structure keeps shared credential maps and startup defaults under separate provider IDs; see [Settings](#-settings) for editing and session precedence.
Credential values are private and must not be committed.
When neither canonical nor legacy storage exists, reads return an empty store without creating a directory or file.
The first account change creates the private canonical file.

On first load, if `pi-accounts.json` does not exist and released `pi-codex-accounts.json` does, the extension:

1. Locks and validates the legacy file.
2. Repairs its permission to `0600`.
3. Copies all Codex credentials and the active name into the `openai-codex` provider section.
4. Atomically installs private `pi-accounts.json`.
5. Retains the private legacy file for rollback.

If both files exist, `pi-accounts.json` takes precedence and the legacy file is not imported again.
The retained legacy refresh token may become stale after `pi-accounts` rotates it, so rollback can require a new Codex login.
Older releases reject files that contain provider sections added later.
Before downgrading, stop Pi, back up the file, and remove provider sections the older release does not support (including `meta` and `openai`).
Releases without API key profiles also reject accounts with `type: "api_key"`; remove those accounts and any defaults referring to them from the downgrade copy.

## 🚧 Limitations

- Named API key profiles cover only the supported login providers, not every API-key-only provider in Pi.
- Named profiles store literal keys locally; continue using Pi's `auth.json`, environment variables, or `!command` secret-manager resolution for externally managed secrets.
- Automatic recovery applies only to saved OpenAI OAuth profiles using the official native Responses endpoint; it does not inventory quota or report usage.
- Recovery requires a current Node runtime and the native provider. Custom endpoints or authentication overrides are not eligible for probes.
- It does not support arbitrary custom providers.
- Live OAuth login and model requests depend on provider service availability and account entitlement.
- Sessions created before session-local selection support cannot recover a historical per-session choice; see [Settings](#-settings).

## 🗂️ Package layout

```text
pi-accounts/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── accounts.ts                    # Account activation and session lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, OAuth accounts, API key profiles, OpenAI, Meta, Muse, OpenAI Codex, ChatGPT Plus, ChatGPT Pro, Anthropic, Claude Pro, Claude Max, GitHub Copilot, GitHub Enterprise, Kimi For Coding, Kimi Code, OpenRouter, Radius, xAI, Grok, SuperGrok, X Premium, account switching.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
