/**
 * Schema handling for the pi-durable port.
 *
 * The DSH build carried a 600-line migration from schema 10 (legacy prompt configs, GitHub cursors, Feishu
 * threads). The port starts from a fresh state directory: there is no DSH-era database to migrate, and the
 * prompt/GitHub source tables it converted no longer exist. A schema 10 file is refused with a clear message
 * instead of being half-migrated.
 */
export const SCHEMA_VERSION = 11
export const OLDEST_SCHEMA = 11

export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} predates schema ${OLDEST_SCHEMA}; the pi-durable port starts from a new state directory`

export function migrateTo11(_store: unknown): void {
  throw new Error('The pi-durable port has no schema-10 migration; use a new state directory')
}
