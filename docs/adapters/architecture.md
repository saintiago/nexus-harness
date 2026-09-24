# Adapters

## Responsibility

Perform explicitly requested external operations. Own authentication, protocol translation and
provider-specific errors. Return observed results.

Each adapter is an independent module under src/adapters/. There is no shared adapter service.

## Interface

Use the [shared result and event types](../high-level-architecture.md#shared-interface-vocabulary).
Construction supplies the connection, credentials or host capability needed by that adapter.

Actions decide what to do. Adapters perform the requested external operation. Consumers decide what
to preserve as artifacts.

Define each concrete adapter's typed operations from its consumers' requirements. An operation specifies
its inputs, returned data and errors. Do not build an API catalogue in advance of those requirements.

Provider-specific data stays provider-specific. Keep the information consumers need, including document
structure, identities and revisions. Introduce a common representation only when a consumer needs one.

## Implementation rules

- Use existing provider libraries and process facilities where they meet the required contract.
- Keep authentication and protocol details within the adapter; exclude secrets from returned diagnostics.
- A collection read must return the complete requested collection or an error. Do not fetch unrelated
  collections merely because they are available.
- A failed request does not prove that a remote write had no effect. The caller decides whether to
  retry or inspect the external state.
- Return data or streams. Temporary files required by a provider's transport belong to that adapter;
  Nexus artifact storage belongs to the consumer.
- Release resources owned by the operation when it finishes.
