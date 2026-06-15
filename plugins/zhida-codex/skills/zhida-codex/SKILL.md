---
name: zhida-codex
description: Use the Zhida Codex MCP server whenever the user asks to inspect Zhida support replies, explain retrieval misses, directly edit knowledge base or keyword entries from instructions, create knowledge or keyword entries, optimize a knowledge base, tune keywords, preview reviewed changes, apply confirmed changes, roll back a Zhida changeset, switch Zhida accounts, log out of Zhida, reconnect Zhida, or change the authorized Zhida project.
---

# Zhida Codex

Use the `zhida-codex` MCP tools to make evidence-based or user-directed knowledge and keyword changes. The job is not to give generic advice. For support-log optimization, read the real trace and diagnose the failure. For direct edit commands, locate the real entry, create a reviewed preview, and apply it only after explicit confirmation.

## Hard Rules

- Never write knowledge or keywords before reading the relevant evidence. For support-log work, read conversation, retrieval evidence, and current entries. For direct edit commands, read or search the current target entries first.
- Never invent request IDs, conversation UUIDs, knowledge UUIDs, keyword UUIDs, hashes, or matched documents.
- Never create a duplicate entry when an existing knowledge or keyword entry can be updated.
- Never call `apply_knowledge_changes` until the user explicitly confirms the specific `change_set_uuid`.
- If target evidence is missing or ambiguous, say exactly what is missing and stop before proposing writes.
- If the answer was acceptable or the gap is not caused by knowledge/keywords, recommend no change.

## Tool Routing

- Account/project/logout/reconnect requests: use the Account Switching flow. Do not inspect support data first.
- Direct edit command with a knowledge UUID: call `get_knowledge_entry`, then preview the requested update.
- Direct edit command with a keyword UUID: call `get_keyword_entry`, then preview the requested update.
- Direct edit command without a UUID: call `search_knowledge_entries` or `search_keyword_entries` based on the user's wording. If the target type is unclear, search both. If exactly one target is clearly intended, preview the edit. If multiple plausible targets exist, ask the user to choose one.
- Direct create command: if the user clearly asks to add a new reusable answer or keyword rule, search first to avoid duplicates, then preview `create_knowledge` or `create_keyword`.
- User provides `request_id`: call `get_optimization_context` first. This is the main workhorse.
- User asks why one reply missed or used knowledge but gives no `request_id`: ask for `request_id`; do not pretend conversation-only data proves retrieval behavior.
- Recent review with no `request_id`: call `list_recent_conversations`, then `get_conversation_detail` for relevant conversations. Use this only for conversation-quality review unless a request_id is available.
- User asks which project is authorized: call `list_projects`.
- Existing changeset: use `apply_knowledge_changes` or `rollback_change` only for the provided `change_set_uuid` after confirming intent.

## Direct Edit Procedure

Use this path when the user directly instructs Codex to add, rewrite, rename, enable, disable, retag, or adjust knowledge/keyword entries.

1. Identify intent:
   - Knowledge entry: title, answer content, tags, status, or general FAQ wording.
   - Keyword entry: keys, direct answer content, match mode, tags, or status.
   - If the command mentions both, handle both in one minimal changeset when the relationship is clear.

2. Locate target:
   - If a UUID is present, use `get_knowledge_entry` or `get_keyword_entry`.
   - If no UUID is present, use `search_knowledge_entries` or `search_keyword_entries` with the strongest phrase from the user's instruction.
   - If search returns no matching entry and the user asked to update, ask whether to create a new entry instead.
   - If search returns multiple plausible entries, list the candidates with UUID/title or keys and ask the user to choose.

3. Build the minimal operation:
   - Preserve any field the user did not ask to change.
   - Include `before_hash` from the search/get result when updating.
   - For keyword key changes, keep existing useful keys unless the user explicitly says to replace them.
   - Use status changes only when the user explicitly asks to enable, disable, publish, hide, or equivalent.

4. Preview and confirm:
   - Call `preview_knowledge_changes`.
   - Show the `change_set_uuid`, target UUID, and the meaningful before/after change.
   - Ask for explicit confirmation before `apply_knowledge_changes`.

## Required Investigation Procedure

When `get_optimization_context` is available, consume it in this exact order:

1. Conversation pass:
   - Read `analysis_view.conversation.messages` or `messages`.
   - Identify the customer request, the assistant answer, and the surrounding turns that affect meaning.
   - Decide what is wrong before looking at the knowledge base: missing answer, wrong answer, too broad, too narrow, bad tone, or no issue.

2. Retrieval pass:
   - Read `analysis_view.summary` and `analysis_view.optimization_hints`.
   - Read `analysis_view.retrieval.keyword`, `counts`, and `flow`.
   - For keyword matches, inspect `keyword.uuid`, `keyword.keys`, and the keyword answer path first.
   - For vector retrieval, inspect `flow.vector_top`, `flow.rerank_top`, and especially `flow.prompt_used`.
   - Determine whether the failure is: no candidate, candidate not used, wrong keyword direct answer, insufficient prompt-used knowledge, stale content, prompt budget/rerank issue, or model misuse of good context.

3. Current entries pass:
   - Read `current_knowledges` and `current_keywords`, or `analysis_view.current_snapshot`.
   - Compare only after the conversation and retrieval passes.
   - Locate the best existing entry by UUID/title/keys/content before creating anything.

4. Diagnosis pass:
   - State the root cause in one sentence tied to evidence.
   - Choose one decision: no-op, update knowledge, create knowledge, update keyword, create keyword, both knowledge and keyword, or non-knowledge issue.

## Decision Matrix

- `keyword.matched=true` and answer wrong: update that keyword content. Add keys only if user wording should have matched but did not.
- `keyword.matched=true` and answer right: no knowledge change. Do not add duplicate knowledge.
- `vector_results=0` and the issue is a real supported FAQ: create knowledge. Add keyword only when the user's wording is likely common and should trigger directly.
- `vector_results>0` and `prompt_used=0`: do not create duplicate knowledge. Inspect retrieved candidates; update existing content only if it is weak or stale. Otherwise report retrieval/rerank/prompt-budget issue.
- `prompt_used` contains the right knowledge but answer missed details: update the existing knowledge only if the content is ambiguous or incomplete; otherwise report model/prompt-following issue.
- Existing knowledge is relevant but incomplete/stale: update knowledge.
- Existing keyword keys miss common wording but answer content is good: update keyword keys.
- Existing keyword answer is stale or misleading: update keyword content.
- No existing relevant entry and the customer issue is clear, reusable, and answerable: create knowledge.
- Single ambiguous conversation with no clear reusable policy: no write; ask for more examples or mark for manual review.

## Change Construction

Use `preview_knowledge_changes` for every proposed write.

- `create_knowledge`: include a precise title, complete answer-ready content, and useful tags.
- `update_knowledge`: include `uuid`, include `before_hash` when search/get returned one, and only set fields that should change.
- `create_keyword`: include stable user phrasings in `keys`, answer text in `content`, optional tags, and `match_mode` only when needed.
- `update_keyword`: include `uuid`, include `before_hash` when search/get returned one, and update `keys`, `content`, `tags`, `match_mode`, or `status` only when supported.
- Keep operations minimal. Prefer one corrected entry over several broad entries.
- Do not preview speculative alternatives. Preview the best supported fix.

## Output Contract

For investigation or optimization work, answer in this order:

1. Conversation: the exact customer need and assistant outcome.
2. Retrieval: keyword/vector/rerank/prompt-used facts.
3. Current entries: knowledge/keyword UUIDs or titles checked.
4. Root cause: the shortest evidence-backed diagnosis.
5. Proposed change: concrete edits, or "no change".
6. Preview: call `preview_knowledge_changes` when a write is justified, then show `change_set_uuid` and before/after meaning.
7. Confirmation: ask whether to apply that `change_set_uuid`.

For no-op findings, stop after root cause and explain why no preview is needed.

For direct edit work, answer in this order:

1. Target: the matched knowledge/keyword UUID and title or keys.
2. Requested edit: the concrete field changes.
3. Preview: call `preview_knowledge_changes`, then show `change_set_uuid` and before/after meaning.
4. Confirmation: ask whether to apply that `change_set_uuid`.

## Account Switching

When the user asks to switch accounts, log out, reconnect, reauthorize, or change project:

1. If `logout_current_session` is available, call it first. This revokes the token already loaded in the active Codex conversation.
2. If shell access is available, run:

```bash
codex mcp logout zhida-codex
```

3. For switching accounts or projects, then run:

```bash
codex mcp login zhida-codex
```

4. Tell the user that local logout clears persisted credentials, but an already loaded conversation may keep using its in-memory token until `logout_current_session` revokes it or the conversation is restarted.
5. If shell access is not available, give the same commands to the user. Do not ask them to reinstall the plugin just to switch accounts or projects.

## Operation Examples

```json
{
  "operations": [
    {
      "op": "update_knowledge",
      "uuid": "knowledge-uuid",
      "title": "Android login failure",
      "content": "Clear app cache, confirm the latest version, then retry login. If it still fails, send the error screenshot to support.",
      "tags": ["android", "login"]
    }
  ]
}
```

```json
{
  "operations": [
    {
      "op": "update_keyword",
      "uuid": "keyword-uuid",
      "keys": ["android cannot open", "android app fails to launch"],
      "content": "Clear app cache, confirm the latest version, then retry login.",
      "tags": ["android"]
    }
  ]
}
```
