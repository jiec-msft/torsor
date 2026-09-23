# Torsor

> English | [简体中文](README.zh-cn.md)

Torsor is an open-source environment for durable collaboration between people and software agents.

Agents may stop, restart, or move between hosts. The work should continue from durable state.

> Agents change. Work persists.

## Why Torsor?

In mathematics, a torsor is like a space with no distinguished origin: relationships remain meaningful even when no single point is permanently central.

Torsor applies that idea to agent work. No agent session should become the irreplaceable owner of a goal, decision, or next action.

## Status

Torsor is at an early design and implementation stage. The first working slice will focus on one person coordinating replaceable agent sessions through durable work state.

## Documentation

- [Independent ACP provider conformance harness](packages/acp-conformance/README.md) ([简体中文](packages/acp-conformance/README.zh-cn.md))

- [Product definition](docs/product.md) ([简体中文](docs/product.zh-cn.md))
- [MVP 0.1 core and interactive prototype](docs/prototype/001-overview.md) ([简体中文](docs/prototype/001-overview.zh-cn.md))
- [Documentation language and pairing policy](docs/documentation.md) ([简体中文](docs/documentation.zh-cn.md))
- [Public content policy](docs/public-content.md) ([简体中文](docs/public-content.zh-cn.md))
- [Contributing](CONTRIBUTING.md) ([简体中文](CONTRIBUTING.zh-cn.md))
- [Security policy](SECURITY.md) ([简体中文](SECURITY.zh-cn.md))

## Human Run controls

In production Web Run detail, `Cancel Run` cancels an eligible logical work line; `Withdraw Input` withdraws only Pending input you assigned, without deleting its public Message. Cancellation does not confirm physical Provider stop or safe Worktree release; this view cannot confirm physical stop or quarantine. For an unknown response, use `Retry same action`, not a replacement request. Refresh and review revision / conflict rejections; reauthentication or reload in the same window retains the original recovery identity. After acknowledged commit with failed reads, use read-only refresh inside the controls. See the [Human controls specification](docs/prototype/001-overview.md#4421-human-cancel-and-withdraw-controls).

## License

Torsor is licensed under the Apache License 2.0.
