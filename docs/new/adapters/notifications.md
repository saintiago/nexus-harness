# Notifications adapter

## Responsibility

Send an explicitly supplied notification through the configured provider.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies the provider connection, credentials and destination.
The consumer supplies the subject and body.

Return the provider's publication result. The initial provider is SNS.
The consumer owns report content, persistence and decisions about further notification attempts.

### Required capability

publish(subject, body) sends one message to the configured destination and returns its provider
message identity. [Application](../application.md#component-wiring) uses this for recovery reports.

## Behavior

Provider acceptance is not confirmation of inbox delivery.
Report provider limits and failures without silently truncating the content.
