type StartupFailure = { code: string; message: string };

const failures: Record<string, StartupFailure> = {
  schema: {
    code: 'WORKER_SCHEMA_MISSING',
    message:
      'Database tables or columns are missing. Check the Docker Compose project and volume after moving the project. Run pnpm db:deploy only against the intended database.',
  },
  connection: {
    code: 'WORKER_DATABASE_UNAVAILABLE',
    message:
      'PostgreSQL is unavailable. Start docker compose up -d postgres, check DATABASE_URL, then restart the worker.',
  },
  authentication: {
    code: 'WORKER_DATABASE_AUTH_FAILED',
    message:
      'PostgreSQL rejected authentication. Check the backend DATABASE_URL credentials.',
  },
  database: {
    code: 'WORKER_DATABASE_MISSING',
    message:
      'The configured PostgreSQL database does not exist. Check DATABASE_URL and the selected Docker volume.',
  },
  lock: {
    code: 'WORKER_ALREADY_RUNNING',
    message:
      'Another messaging worker owns this database. Keep only one worker; pnpm dev already starts it.',
  },
  configuration: {
    code: 'WORKER_CONFIGURATION_INVALID',
    message:
      'Backend configuration is invalid. Check the required variables in apps/api/.env.',
  },
  unknown: {
    code: 'WORKER_STARTUP_FAILED',
    message:
      'Worker startup failed. Check PostgreSQL, migrations, configuration and worker ownership.',
  },
};

/** Return only allowlisted diagnostics: provider errors can contain credentials. */
export function describeWorkerStartupFailure(error: unknown): StartupFailure {
  const codes = new Set<string>();
  const seen = new Set<object>();
  let invalidConfiguration = false;
  function inspect(value: unknown, depth: number) {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value))
      return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['code', 'errorCode'])
      if (typeof record[key] === 'string') codes.add(record[key]);
    if (
      typeof record.message === 'string' &&
      record.message.startsWith('Invalid configuration:')
    )
      invalidConfiguration = true;
    inspect(record.cause, depth + 1);
    if (Array.isArray(record.errors))
      for (const child of record.errors.slice(0, 10)) inspect(child, depth + 1);
  }
  inspect(error, 0);
  if (codes.has('WORKER_ALREADY_RUNNING')) return failures.lock;
  if (['P2021', 'P2022', '42P01', '42703'].some((code) => codes.has(code)))
    return failures.schema;
  if (['P1000', '28P01', '28000'].some((code) => codes.has(code)))
    return failures.authentication;
  if (['P1003', '3D000'].some((code) => codes.has(code)))
    return failures.database;
  if (
    [
      'P1001',
      'P1002',
      'P1017',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ECONNRESET',
    ].some((code) => codes.has(code))
  )
    return failures.connection;
  if (invalidConfiguration) return failures.configuration;
  return failures.unknown;
}
