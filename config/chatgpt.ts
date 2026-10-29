// Public PKCE client identifier, not a client secret. This Codex-compatible
// integration is distinct from OpenAI's dynamically registered OSS clients.
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_AUTH_ORIGIN = 'https://auth.openai.com';
export const CHATGPT_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
export const CHATGPT_PROVIDER_URL = 'https://chatgpt.com/backend-api/codex';
// Catalog schema compatibility target from OpenAI's model-catalogs example.
// This is independent of Glintab's version and requires no installed Codex CLI.
export const CHATGPT_CATALOG_VERSION = '0.162.1';
export const CHATGPT_PERMISSION_ORIGINS = ['https://auth.openai.com/*', 'https://chatgpt.com/*'];
export interface ChatGPTFlow {
  flowId: string;
  statusKey: string;
}
export interface ChatGPTLoginStatus {
  status: 'pending' | 'exchanging' | 'connected' | 'error' | 'cancelled';
  error?: string;
  connection?: { id: string; email: string; draftKey: string };
}
