export type ApiFormat = 'openai_chat' | 'anthropic' | 'openai_responses';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface Provider {
  authType?: 'api_key' | 'chatgpt';
  chatgpt?: { connectionId: string; email: string; draftKey?: string };
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ApiFormat;
  stream?: boolean;
  reasoningEffort?: ReasoningEffort;
  contextLimit: number;
  createdAt: number;
}
export interface DomainPrompt {
  id: string;
  domain: string;
  prompt: string;
}
export interface Settings {
  summaryLanguage: 'zh' | 'en' | 'auto';
  webPrompt: string;
  videoPrompt: string;
  domainPrompts?: DomainPrompt[];
  showContent: boolean;
}
export interface AppConfig {
  schemaVersion: 2;
  providers: Provider[];
  currentProviderId: string | null;
  settings: Settings;
  transcription?: TranscriptionConfig;
}
export interface TranscriptionConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  responseFormat: 'json' | 'verbose_json';
}
export interface BilibiliAudio {
  url: string;
  videoId: string;
  part: number;
  cid: number;
  duration: number;
  audioUrl: string;
}
export interface PageSource {
  pageKey: string;
  url: string;
  title: string;
  content: string;
  originalLength: number;
  truncated: boolean;
  extractedAt: number;
  fallback: boolean;
  video?: VideoSource;
}
export type VideoPlatform = 'youtube' | 'bilibili';
export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}
export interface VideoSource {
  platform: VideoPlatform;
  videoId: string;
  part?: number;
  language: string;
  automatic: boolean;
  segments: SubtitleSegment[];
  transcription?: 'required' | 'complete';
  timestamps?: boolean;
}
// MAIN-world output is untrusted and is validated again in the background.
export interface VideoPageResult {
  url: string;
  videoId: string;
  title: string;
  part?: number;
  language: string;
  automatic: boolean;
  format: 'youtube-json3' | 'segments' | 'bilibili-audio-required';
  body: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  hidden?: boolean;
}
export interface Conversation {
  id: string;
  source: PageSource;
  messages: ChatMessage[];
  updatedAt: number;
  revision: string;
  notice?: string;
}
export interface TaskSnapshot {
  streamId: string;
  startedAt: number;
  sequence: number;
  tabId: number;
  pageKey: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  conversation: Conversation;
  error?: string;
  progress?: string;
}
export interface StartTask {
  streamId: string;
  tabId: number;
  conversation: Conversation;
  provider: Provider;
  settings: Settings;
  question: string;
  summary: boolean;
  editMessageId?: string;
  transcription?: TranscriptionConfig;
}
export interface EngineEvent {
  channel: 'glintab:event';
  snapshot: TaskSnapshot;
  persist: boolean;
}
export type Request =
  | { type: 'chatgpt:login:start'; providerId?: string }
  | { type: 'chatgpt:login:status'; flowId: string; statusKey: string }
  | { type: 'chatgpt:login:cancel'; flowId: string; statusKey: string }
  | { type: 'chatgpt:connection:discard'; connectionId: string; draftKey: string }
  | { type: 'chatgpt:auth:get'; connectionId: string; draftKey?: string }
  | { type: 'config:get' }
  | {
      type: 'provider:save';
      provider: Provider;
      authJson?: string;
      authRevision?: string;
      replaceAuth?: boolean;
    }
  | { type: 'provider:delete'; id: string }
  | { type: 'provider:select'; id: string }
  | { type: 'settings:save'; settings: Settings }
  | { type: 'transcription:save'; config: TranscriptionConfig }
  | { type: 'models:list'; provider: Provider }
  | { type: 'page:extract'; tabId: number; expectedPageKey: string }
  | { type: 'conversation:get'; pageKey: string }
  | {
      type: 'task:start';
      tabId: number;
      conversation: Conversation;
      question: string;
      summary: boolean;
      streamId: string;
      editMessageId?: string;
    }
  | { type: 'task:snapshot'; tabId: number; pageKey: string }
  | { type: 'task:cancel'; tabId: number; streamId: string }
  | { type: 'window:open'; tabId: number }
  | { type: 'drawer:close'; tabId: number }
  | { type: 'data:clear' };
export type EngineRequest =
  | { target: 'engine'; type: 'start'; task: StartTask }
  | { target: 'engine'; type: 'snapshot'; tabId: number; pageKey: string }
  | { target: 'engine'; type: 'cancel'; tabId: number; streamId: string }
  | { target: 'engine'; type: 'active' };
export interface RpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AuthJsonSnapshot {
  json: string;
  revision: string;
  invalid: boolean;
}
// Private records are only read/written by background Repository instances.
export interface ChatGPTAuthRecord {
  version: 1;
  id: string;
  subject: string;
  accountId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  revision: string;
  invalid?: boolean;
}
export interface ChatGPTAuthFlow {
  id: string;
  statusKey: string;
  state: string;
  nonce: string;
  verifier: string;
  tabId: number;
  expiresAt: number;
  existingId?: string;
  status: 'pending' | 'exchanging' | 'connected' | 'cancelled' | 'error';
  connectionId?: string;
  error?: string;
}
export interface ChatGPTCredentials {
  accessToken: string;
  accountId: string;
  revision: string;
}
export interface AuthCredentialRequest {
  channel: 'glintab:auth';
  connectionId: string;
  rejectedRevision?: string;
}
export interface AudioSourceRequest {
  channel: 'glintab:audio';
  tabId: number;
  pageKey: string;
  streamId: string;
}
export interface PreparedAudio {
  chunks: { data: ArrayBuffer; offset: number; duration: number }[];
}
