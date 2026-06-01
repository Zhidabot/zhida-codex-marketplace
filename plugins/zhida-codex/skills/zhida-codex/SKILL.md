---
name: zhida-codex
description: Use the Zhida Codex MCP server to inspect authorized Zhida support conversations, retrieval traces, knowledge bases, keywords, and reviewed changesets.
---

# Zhida Codex

Use this skill when the user asks Codex to optimize a Zhida knowledge base, inspect a customer-support answer, review retrieval logs, or apply a reviewed knowledge/keyword changeset.

## Workflow

1. Check the available `zhida-codex` MCP tools. If authentication is required, ask the user to complete the browser authorization flow.
2. Start from real evidence:
   - Use `get_optimization_context` when the user provides a `request_id`.
   - Use `list_recent_conversations` and `get_conversation_detail` when the user asks for recent support quality review.
   - Use `get_retrieval_trace` to explain why a specific reply used or missed knowledge.
3. Propose structured operations only after reviewing the current knowledge and keyword snapshots.
4. Call `preview_knowledge_changes` before any write. Show the returned diff/change-set summary to the user.
5. Call `apply_knowledge_changes` only after the user confirms the preview.
6. Use `rollback_change` if a confirmed change needs to be reverted.

## Operation Shape

Supported operations:

```json
{
  "op": "update_knowledge",
  "uuid": "knowledge-uuid",
  "before_hash": "hash-from-preview-context",
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

Do not invent request IDs, UUIDs, or hashes. Read them from the MCP tool results.
