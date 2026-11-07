import { describe, expect, it } from 'vitest';
import { describeWorkerStartupFailure } from '../src/common/worker-startup-error';

describe('safe worker startup diagnostics', () => {
  it('identifies a missing schema without exposing database errors or secret values', () => {
    const failure = describeWorkerStartupFailure({
      code: 'P2021',
      message: 'Missing table; password=private-fixture-secret',
      meta: { modelName: 'PersonalWorkerState' },
    });
    expect(failure.code).toBe('WORKER_SCHEMA_MISSING');
    expect(failure.message).toContain('volume');
    expect(failure.message).toContain('pnpm db:deploy');
    expect(JSON.stringify(failure)).not.toContain('private-fixture-secret');
  });
  it('recognizes missing columns and raw PostgreSQL missing-table errors', () => {
    for (const code of ['P2022', '42P01', '42703'])
      expect(describeWorkerStartupFailure({ code }).code).toBe(
        'WORKER_SCHEMA_MISSING',
      );
  });
  it('recognizes Prisma initialization errors and nested Node connection failures', () => {
    expect(describeWorkerStartupFailure({ errorCode: 'P1001' }).code).toBe(
      'WORKER_DATABASE_UNAVAILABLE',
    );
    expect(
      describeWorkerStartupFailure(
        new AggregateError([
          Object.assign(new Error('secret connection URL'), {
            code: 'ECONNREFUSED',
          }),
        ]),
      ).code,
    ).toBe('WORKER_DATABASE_UNAVAILABLE');
  });
  it('distinguishes authentication, missing database and a second worker', () => {
    expect(describeWorkerStartupFailure({ code: '28P01' }).code).toBe(
      'WORKER_DATABASE_AUTH_FAILED',
    );
    expect(describeWorkerStartupFailure({ code: 'P1003' }).code).toBe(
      'WORKER_DATABASE_MISSING',
    );
    expect(
      describeWorkerStartupFailure({ code: 'WORKER_ALREADY_RUNNING' }).code,
    ).toBe('WORKER_ALREADY_RUNNING');
  });
  it('redacts configuration values and unexpected errors', () => {
    const secret = 'private-fixture-token';
    const configuration = describeWorkerStartupFailure(
      new Error('Invalid configuration: ' + secret),
    );
    expect(configuration.code).toBe('WORKER_CONFIGURATION_INVALID');
    expect(JSON.stringify(configuration)).not.toContain(secret);
    expect(describeWorkerStartupFailure(new Error(secret))).toMatchObject({
      code: 'WORKER_STARTUP_FAILED',
    });
    expect(
      JSON.stringify(describeWorkerStartupFailure(new Error(secret))),
    ).not.toContain(secret);
  });
  it('handles cyclic causes and absent errors without throwing', () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    for (const value of [error, undefined, null, 'provider secret'])
      expect(describeWorkerStartupFailure(value).code).toBe(
        'WORKER_STARTUP_FAILED',
      );
  });
});
