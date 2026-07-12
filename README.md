# Zhida Codex Marketplace

Codex plugin marketplace for installing the Zhida Codex plugin.

## Install

```bash
codex plugin marketplace add https://github.com/Zhidabot/zhida-codex-marketplace --ref main
codex plugin add zhida-codex@zhida
```

Node.js 18 or newer must be available in the environment where Codex runs. After installation, ask Codex to connect your Zhida account. The plugin opens Chrome first on desktop, uses Safari as the macOS fallback, and shows a verification link plus one-time code on a headless server. The local bridge receives the authorization automatically; no localhost callback or pasted token is required.
