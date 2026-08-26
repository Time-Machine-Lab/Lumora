## Why

The provider-neutral storyboard workflow introduced by TML-55 currently has only an offline Mock provider and snapshots each provider's model list at activation. TML-297 needs a launch provider that can call a user-selected OpenAI-compatible Chat Completions endpoint while preserving the host schema, cancellation, privacy, and plugin lifecycle boundaries.

This change is based on reviewed PR #8 head `c034f7de6d1caa488e2cd466aba49f4f0cb2f2a3` because PR #8 is not merged. It is delivered on a separate branch and does not modify the reviewed PR head.

## What Changes

- Add a provider-neutral dynamic storyboard model catalog so configurable providers can expose their latest model at discovery and submission time while static Mock catalogs remain unchanged.
- Add stable authentication and browser-network provider error codes with host-owned, non-sensitive summaries.
- Add an independent OpenAI-compatible plugin containing endpoint/model settings, runtime-only API key handling, Chat Completions requests, structured storyboard prompting, response parsing, timeout/cancellation, and error mapping.
- Add an immediate connection test with actionable validation, authentication, CORS/network, timeout, rate-limit, availability, and response-shape feedback.
- Register the plugin in the embedded host and cover the real settings-to-generation-to-adoption flow on desktop and mobile with controlled fetch/route fakes.

## Capabilities

### New Capabilities

- openai-compatible-storyboard-provider: Defines configurable OpenAI-compatible storyboard generation, secret isolation, connection testing, protocol behavior, errors, and lifecycle cleanup.

### Modified Capabilities

None.

## Impact

Core and plugin-sdk gain a backward-compatible dynamic storyboard model catalog type and two provider-neutral error codes. The OpenAI protocol, headers, prompts, endpoint validation, and response parsing remain entirely inside the new plugin package. Studio receives only a generic panel-reveal usability fix and continues to consume provider-neutral discovery/task APIs. No image provider, vendor marketplace, billing, proxy platform, or automatic retry is added.
