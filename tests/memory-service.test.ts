/**
 * Focused integration tests: the real Memory service client against a controlled AMEM service
 * over loopback HTTP. They establish the documented request and response handling, stable
 * submission identities, lost-acknowledgement retry, accepted-versus-stored reporting and the
 * explicit unavailability the client reports instead of failing a business action.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryServiceClient, disabledMemory } from '../src/memory/index.js';
import {
  controlledMemoryService,
  searchResult,
  type ControlledMemoryService,
} from './support/memory.js';

const services: ControlledMemoryService[] = [];

async function service(): Promise<ControlledMemoryService> {
  const created = await controlledMemoryService();
  services.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((created) => created.close()));
});

const observation = {
  sourceKey: 'NEX-1/round-1/summary',
  content: 'The retry guard must preserve the identical source key across transport retries.',
  timestamp: '2026-09-29T10:00:00Z',
  provenance: { project: 'NEX', role: 'developer', round: 1 },
};

describe('memory search', () => {
  it('sends the focused query and public limits and returns complete attributed results', async () => {
    const controlled = await service();
    controlled.results = [
      searchResult({ content: 'A direct match.', keywords: ['retry'] }, { score: 0.91 }),
      searchResult({ content: 'A linked addition.', tags: ['recovery'] }, 'link'),
    ];
    const memory = createMemoryServiceClient({ url: controlled.url });

    const result = await memory.search({ query: 'retry guard', limit: 3, linkedLimit: 2 });

    expect(result.kind).toBe('results');
    if (result.kind !== 'results') {
      throw new Error('the search did not return results');
    }
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      via: 'match',
      score: 0.91,
      note: { content: 'A direct match.', keywords: ['retry'] },
    });
    expect(result.results[1]).toMatchObject({
      via: 'link',
      note: { content: 'A linked addition.' },
    });
    expect(controlled.requests).toEqual([
      {
        method: 'POST',
        path: '/v1/search',
        body: { query: 'retry guard', limit: 3, linkedLimit: 2 },
      },
    ]);
    await memory.close();
  });

  it('reports an unavailable service instead of an empty success', async () => {
    const controlled = await service();
    controlled.intercept('/v1/search', () => ({
      status: 503,
      body: {
        error: {
          code: 'unavailable',
          message: 'The retrieval capability is unavailable.',
          retryable: true,
        },
      },
    }));
    const memory = createMemoryServiceClient({ url: controlled.url });

    const result = await memory.search({ query: 'anything' });

    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'The retrieval capability is unavailable.',
      retryable: true,
    });
    await memory.close();
  });

  it('reports an unreachable service and a response outside the contract', async () => {
    const controlled = await service();
    controlled.intercept('/v1/search', () => ({ status: 200, body: { results: [] } }));
    const memory = createMemoryServiceClient({ url: controlled.url });

    const malformed = await memory.search({ query: 'anything' });
    expect(malformed).toEqual({
      kind: 'unavailable',
      reason: 'the memory service answered outside its documented response contract',
      retryable: false,
    });

    const unreachable = createMemoryServiceClient({ url: 'http://127.0.0.1:1' });
    const result = await unreachable.search({ query: 'anything' });
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') {
      throw new Error('the unreachable search was not unavailable');
    }
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe('the memory service could not be reached');
    await Promise.all([memory.close(), unreachable.close()]);
  });
});

describe('memory submission', () => {
  it('submits one observation unchanged and reports durable acceptance', async () => {
    const controlled = await service();
    const memory = createMemoryServiceClient({ url: controlled.url });

    const result = await memory.submit(observation);

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') {
      throw new Error('the submission was not accepted');
    }
    expect(result.created).toBe(true);
    expect(result.receipt).toMatchObject({ sourceKey: observation.sourceKey, status: 'queued' });
    expect(result.receipt.noteId).toBeUndefined();
    expect(controlled.requests[0]).toEqual({
      method: 'POST',
      path: '/v1/observations',
      body: observation,
    });
    await memory.close();
  });

  it('refuses a changed payload under an accepted source key', async () => {
    const controlled = await service();
    const memory = createMemoryServiceClient({ url: controlled.url });
    const first = await memory.submit(observation);
    expect(first.kind).toBe('accepted');

    const changed = await memory.submit({ ...observation, content: 'A different observation.' });

    expect(changed).toEqual({
      kind: 'refused',
      reason: 'The source key is already accepted with a different observation.',
      retryable: false,
    });
    expect(controlled.observations.size).toBe(1);
    await memory.close();
  });

  it('retries a lost acknowledgement with the identical key and payload', async () => {
    const controlled = await service();
    let intercept = true;
    controlled.intercept('/v1/observations', () => {
      if (!intercept) {
        return null;
      }
      intercept = false;
      return 'accept-then-close';
    });
    const memory = createMemoryServiceClient({ url: controlled.url });

    const lost = await memory.submit(observation);
    expect(lost.kind).toBe('unavailable');
    if (lost.kind !== 'unavailable') {
      throw new Error('the lost acknowledgement was not reported as unavailable');
    }
    expect(lost.retryable).toBe(true);
    const accepted = controlled.observations.get(observation.sourceKey);
    expect(accepted?.receipt.status).toBe('queued');

    const retried = await memory.submit(observation);
    expect(retried.kind).toBe('accepted');
    if (retried.kind !== 'accepted') {
      throw new Error('the identical retry was not accepted');
    }
    expect(retried.created).toBe(false);
    expect(retried.receipt.id).toBe(accepted?.receipt.id);
    expect(controlled.requests.map((request) => request.body)).toEqual([observation, observation]);
    expect(controlled.observations.size).toBe(1);
    await memory.close();
  });

  it('refuses an observation outside the documented contract without contacting the service', async () => {
    const controlled = await service();
    const memory = createMemoryServiceClient({ url: controlled.url });

    const result = await memory.submit({
      sourceKey: '',
      content: '   ',
    });

    expect(result.kind).toBe('refused');
    expect(controlled.requests).toEqual([]);
    await memory.close();
  });

  it('reports a broken acceptance answer as retryable because the outcome is unknown', async () => {
    const controlled = await service();
    let intercept = true;
    controlled.intercept('/v1/observations', () => {
      if (!intercept) {
        return null;
      }
      intercept = false;
      return { status: 202, body: { accepted: true } };
    });
    const memory = createMemoryServiceClient({ url: controlled.url });

    const broken = await memory.submit(observation);

    expect(broken).toEqual({
      kind: 'unavailable',
      reason: 'the memory service answered outside its documented response contract',
      retryable: true,
    });
    // The identical resubmission resolves what the broken answer left unknown.
    const resolved = await memory.submit(observation);
    expect(resolved.kind).toBe('accepted');
    await memory.close();
  });
});

describe('memory receipts', () => {
  it('reports acceptance separately from stored storage and a missing receipt explicitly', async () => {
    const controlled = await service();
    const memory = createMemoryServiceClient({ url: controlled.url });
    const submitted = await memory.submit(observation);
    if (submitted.kind !== 'accepted') {
      throw new Error('the submission was not accepted');
    }

    const queued = await memory.receipt(submitted.receipt.id);
    expect(queued).toMatchObject({ kind: 'receipt', receipt: { status: 'queued' } });

    controlled.store(observation.sourceKey);
    const stored = await memory.receipt(submitted.receipt.id);
    expect(stored.kind).toBe('receipt');
    if (stored.kind !== 'receipt') {
      throw new Error('the stored receipt was not returned');
    }
    expect(stored.receipt.status).toBe('stored');
    expect(stored.receipt.noteId).toBeDefined();

    expect(await memory.receipt(randomUUID())).toEqual({ kind: 'missing' });
    await memory.close();
  });
});

describe('memory lifecycle', () => {
  it('makes no call when the integration is disabled', async () => {
    const memory = disabledMemory();

    expect(await memory.search({ query: 'anything' })).toEqual({ kind: 'disabled' });
    expect(await memory.submit(observation)).toEqual({ kind: 'disabled' });
    expect(await memory.receipt(randomUUID())).toEqual({ kind: 'disabled' });
    await memory.close();
  });

  it('sends no request after the client was closed', async () => {
    const memory = createMemoryServiceClient({
      url: 'http://127.0.0.1:1',
      fetch: () => {
        throw new Error('a closed client must not call its service');
      },
    });

    await memory.close();

    expect(await memory.search({ query: 'anything' })).toMatchObject({
      kind: 'unavailable',
      reason: 'the memory client is closed',
    });
  });
});
