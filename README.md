# pi-durable-superagent (fork of dsh-superagent)

> **This branch (`feat/pi-durable-port`) is the pi-durable port, not the DSH bundle.**
> The Router/Worker domain is unchanged; the DSH runtime, web panel and GitHub source are replaced by
> `@earendil-works/pi-durable` + a Feishu WebSocket source + GLM-5.3. Read
> [docs/pi-durable-port.md](docs/pi-durable-port.md) for the mapping, env table, deploy and limits.
> The original upstream README follows for context.

# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 A2A](docs/009-a2a.md): agent-to-agent endpoint, peers, verified matrix, operations
- [010 Watchdog](docs/010-watchdog.md): turn supervision, verdicts, modes, operations
- [011 Async ReAct](docs/011-async-react.md): `start`/`stop` background jobs and result delivery
- [012 Recall](docs/012-recall.md): inline ids, spill + cursor paging, chained recall
- [013 BYOM daemon](docs/013-byom-daemon.md): device daemon protocol, leases, client loop
- [014 OpenViking hub](docs/014-openviking-hub.md): memory tools, single-writer rule, A2A peer dispatch

## Port status

| Area | State |
|---|---|
| Feishu source, Router/Worker, durable workers | ported and running (`superagent-plugin7`+) |
| A2A (inbound server + outbound `a2a_send`) | done; peers cc2 Hermes, deb01 Hermes, CowAgent — both directions verified |
| Passthrough / fast path (`passthrough` log) | done; conversation-level Threads |
| Watchdog (model-level supervision of a worker) | done: own session, verdicts, nudge/abort — [010](docs/010-watchdog.md); live `observe` run pending |
| Async ReAct (`start`/`stop` tool pair) | done: detached jobs, result delivered as new input — [011](docs/011-async-react.md) |
| Chained recall / inline & spill | first cut: `recall` graph walk, brief spill — [012](docs/012-recall.md) |
| OpenViking memory | `viking_search/read/write/browse`, shared-root single writer — [014](docs/014-openviking-hub.md) |
| Peer dispatch | `peer_list` / `peer_send` over A2A to hermes-cc2 and cowagent-deb02, both dialects — [014](docs/014-openviking-hub.md) |
| On-device daemon (BYOM) | wired: /daemon/* HTTP, broker, `device` tool, CLI executor — [013](docs/013-byom-daemon.md); registry is in-memory, no multi-device policy yet |

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
