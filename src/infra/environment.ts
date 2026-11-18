/**
 * Commands a worker may not block.
 *
 * The DSH implementation shelled out through `@deepseek-ai/dsh-subprocess`, shimmed `gh`/`lark-cli` per
 * deployment account and rewrote git config. The pi-durable port runs workers in an ordinary durable
 * conversation whose bash tool inherits the container environment, so only the allow-list that
 * `policy.ts` validates against remains here.
 */

/** Commands workers need, which `blockedCommands` cannot block. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
