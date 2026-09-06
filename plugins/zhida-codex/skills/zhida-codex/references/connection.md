# 连接智答

插件通过本地 Bridge 和网页授权连接。不要让用户粘贴 access token、refresh token、回调地址或凭证文件。

1. 未连接时调用 `zhida_auth_login`，展示返回的 `verification_uri_complete` 和 `user_code`。验证码只在官方智答授权页输入。
2. 用户完成授权后调用 `zhida_auth_status`，已连接则继续原任务。账号、项目和权限通过 `list_projects` 确认。
3. 如果宿主没有刷新工具列表，说明新会话可以加载工具；不要要求为此重装插件。

切换账号、项目或重新授权时，先调用可用的 `logout_current_session` 撤销当前远端会话，再调用 `zhida_auth_logout` 清理 Bridge 本地凭证，然后重新登录。仅退出时到此结束。

不要运行 `codex mcp login/logout zhida-codex`：它操作原生 HTTP OAuth 存储，不是本插件的 Bridge 凭证。切换项目不需要重装插件。
