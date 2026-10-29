import type { Request, RpcResponse } from '../../types';
export async function rpc<T = void>(request: Request): Promise<T> {
  if (!globalThis.chrome?.runtime?.id) throw new Error('请在已安装的 Glintab 插件中使用此功能。');
  const response: RpcResponse<T> = await chrome.runtime.sendMessage({
    channel: 'glintab:rpc',
    request,
  });
  if (!response?.ok) throw new Error(response?.error || '扩展暂时没有响应，请重新打开面板。');
  return response.data as T;
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
