import { type PostgresAdapter, postgresMigration } from '../postgres/index.js';
import { CliUsageError, listFlag, numberFlag, type ParsedArgs } from './args.js';

const ADAPTERS: readonly PostgresAdapter[] = ['operations', 'store', 'traces', 'evaluation', 'circuits', 'prompts'];

/**
 * `nexus db sql` prints the Postgres schema for the chosen adapters.
 *
 * Printed rather than applied, so the CLI needs no database driver and the schema goes through
 * whatever review and migration tooling the application already has: `nexus db sql | psql "$URL"`.
 */
export async function runDbCommand(subcommand: string | undefined, { flags }: ParsedArgs): Promise<void> {
  if (subcommand !== 'sql') throw new CliUsageError(`Unknown db command "${subcommand ?? ''}". Use sql.`);
  const adapters = listFlag(flags, 'adapters') as PostgresAdapter[] | undefined;
  const unknown = adapters?.filter((adapter) => !ADAPTERS.includes(adapter));
  if (unknown?.length) {
    throw new CliUsageError(`Unknown adapter ${unknown.join(', ')}. Choose from ${ADAPTERS.join(', ')}.`);
  }
  const vectorDimensions = numberFlag(flags, 'vector-dimensions');
  process.stdout.write(
    postgresMigration({
      ...(adapters ? { adapters } : {}),
      ...(vectorDimensions === undefined ? {} : { vectorDimensions }),
    }),
  );
}
