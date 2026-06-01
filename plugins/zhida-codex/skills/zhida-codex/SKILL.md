---
name: zhida-codex
description: Use the Zhida Codex MCP server whenever the user asks to inspect Zhida support replies, explain knowledge or keyword retrieval misses, review conversation quality, optimize a knowledge base, tune keywords, preview reviewed changes, apply confirmed changes, or roll back a Zhida knowledge/keyword changeset.
---

# Zhida Codex

Use the `zhida-codex` MCP tools to work from authorized Zhida project evidence. The goal is to improve knowledge and keyword quality without guessing or writing before review.

## Tool Routing

- If tools require authentication, ask the user to complete the browser authorization flow before continuing.
- If the user provides a `request_id`, start with `get_optimization_context`.
- If the user asks why a reply did or did not use knowledge, call `get_retrieval_trace`.
- If the user asks for recent quality review without a `request_id`, call `list_recent_conversations`, then `get_conversation_detail` for selected conversations.
- If the user asks what project is authorized, call `list_projects`.
- If the user references a previous changeset, use `apply_knowledge_changes` or `rollback_change` only with the provided `change_set_uuid` and only after checking the user's intent.

## Evidence Rules

- Do not invent request IDs, conversation UUIDs, knowledge UUIDs, keyword UUIDs, or hashes. Read them from MCP tool results.
- Ground every proposed edit in evidence: the customer question, assistant reply, retrieval trace, current knowledge, current keywords, or repeated recent conversation patterns.
- Prefer a small correction to the existing knowledge/keyword over creating duplicates.
- Do not create a broad keyword or knowledge entry from a single ambiguous example.
- Preserve useful existing content. Patch the missing or misleading part instead of replacing a working article.
- Summarize sensitive conversation text when possible; quote only the minimum needed to justify a change.

## Write Flow

Never write directly from analysis. Use this sequence:

1. Read evidence with the routing above.
2. Explain the issue and the proposed change.
3. Call `preview_knowledge_changes` with structured operations.
4. Show the preview summary, including `change_set_uuid`, affected entries, and before/after meaning.
5. Wait for explicit user confirmation.
6. Call `apply_knowledge_changes` only after confirmation.

Do not call `apply_knowledge_changes` in the same response as the first preview unless the user already explicitly asked to apply that exact preview.

If preview or apply reports a conflict, stale hash, missing entry, or project mismatch, re-read the context and build a new preview. Do not retry blindly.

## Output Shape

For investigation or optimization work, respond in this order:

1. Evidence: request/conversation/retrieval facts used.
2. Root cause: why the answer missed, overmatched, or needs improvement.
3. Proposed change: knowledge and keyword edits in plain language.
4. Preview: `change_set_uuid` and concise before/after impact after calling preview.
5. Confirmation needed: ask the user whether to apply the preview.

For no-op findings, say that no change is recommended and explain why.

## Operation Examples

Supported operations:

```json
{
  "op": "create_knowledge",
  "title": "How to fix Android login failure",
  "content": "Clear app cache, confirm the latest version, then retry login. If it still fails, send the error screenshot to support.",
  "tags": ["android", "login"]
}
```

```json
{
  "op": "update_knowledge",
  "uuid": "knowledge-uuid",
  "before_hash": "hash-from-previous-preview-if-available",
  "title": "New title",
  "content": "New content",
  "tags": ["tag"]
}
```

```json
{
  "op": "create_keyword",
  "keys": ["android cannot open"],
  "content": "Answer text",
  "match_mode": 0,
  "tags": ["android"]
}
```

```json
{
  "op": "update_keyword",
  "uuid": "keyword-uuid",
  "before_hash": "hash-from-previous-preview-if-available",
  "keys": ["android cannot open", "android app fails to launch"],
  "content": "Answer text",
  "match_mode": 0,
  "tags": ["android"]
}
```

Use `create_knowledge` or `update_knowledge` when the answer content is missing, outdated, or misleading. Use `create_keyword` or `update_keyword` when retrieval should match user wording more reliably. Use both only when the evidence shows both content and matching need changes.
