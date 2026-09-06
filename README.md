# Zhida Codex Marketplace

Codex plugin marketplace for installing the Zhida Codex plugin.

## Install

```bash
codex plugin marketplace add https://github.com/Zhidabot/zhida-codex-marketplace --ref main
codex plugin add zhida-codex@zhida
```

Node.js 18 or newer must be available in the environment where Codex runs. After installation, ask Codex to connect your Zhida account. The plugin opens Chrome first on desktop, uses Safari as the macOS fallback, and shows a verification link plus one-time code on a headless server. The local bridge receives the authorization automatically; no localhost callback or pasted token is required. Permanent knowledge or keyword deletion uses an exact preview and separate user confirmation.

## What it does

Ask Codex which recent customer questions reveal missing or incomplete knowledge. It checks the conversation, retrieval evidence and existing entries, then suggests what to add and where. Missing retrieval alone does not prove missing knowledge. Draft answers use confirmed business facts and retain necessary conditions, steps and links.

General review preserves existing keyword rules and business policies as intentional designs. Keyword review or changes require an explicit request. Internal request IDs are found by the tools.

The plugin reports what was saved and whether the knowledge index has updated. It can check interrupted changes and protect later edits during rollback. It does not ask customers to run sample questions after an edit.
