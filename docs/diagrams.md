# Diagrams

GitHub renders these Mermaid blocks. They describe the built behavior. The
rules behind them are in `docs/decisions/0002-slot-states.md` and
`docs/decisions/0004-mcp-core.md`.

## Slot states

Every arrow fires only after the user accepts the claim in review. When the
order of two claims is unknown, the app raises a conflict instead of moving
the slot. A possibly stale reminder is asked about once and moves nothing.

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Offered: office offers
  [*] --> Confirmed: office confirms or you report it
  Offered --> Requested: you approve an accept reply
  Offered --> Declined: you approve a decline reply
  Offered --> Confirmed: office confirms
  Requested --> Confirmed: office confirms
  state Confirmed {
    [*] --> Held
    Held --> ChangeProposed: office moves it or offers another slot
    ChangeProposed --> Held: you keep it, or office confirms again
  }
  Confirmed --> Canceled: office cancels or you report it
  Offered --> Canceled: cancel claim
  Requested --> Canceled: cancel claim
  Canceled --> Offered: office offers again
  Declined --> Offered: office offers again
```

## Agent change flow

An agent can read, annotate or propose. Only the user's confirmation in the
app changes a slot.

```mermaid
sequenceDiagram
  autonumber
  participant You
  participant App
  participant Store as Shared store
  participant MCP as MCP server
  participant Agent as Your agent
  You->>App: create grant (name, tier)
  App->>Store: grant saved, token hash only
  App-->>You: token shown once
  Agent->>MCP: call tool with token
  MCP->>Store: check grant, tier, rate limit
  MCP->>Store: read case, add note, or queue proposal
  MCP-->>Agent: result, quotes in labeled untrusted fields
  Store-->>App: live refresh shows the note or proposal
  You->>App: confirm or reject the proposal
  App->>Store: evidence reported by you through the grant name
  You->>App: revoke grant
  Agent->>MCP: next call
  MCP-->>Agent: permission error
```
