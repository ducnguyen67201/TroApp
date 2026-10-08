# Worker navigation

The [architecture ownership map](../../../docs/Architecture.md#code-ownership) owns
the current worker responsibilities and communication boundaries. Start there for
agent, teaching, observation, execution, Cua and HUD ownership.

Startup files remain at this root because Electron bundles named utility-worker
entry points. Tests mirror the source folders under `test/desktop/worker`.
