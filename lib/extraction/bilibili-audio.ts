import type { BilibiliAudio, RpcResponse } from '../../types';

// Serialized into the page. No extension configuration or credentials enter MAIN.
export async function readBilibiliAudio(
  expectedUrl: string,
  videoId: string,
  part: number,
): Promise<RpcResponse<BilibiliAudio>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  async function json(url: string) {
    const response = await fetch(url, {
      credentials: 'include',
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`B 站音轨信息请求失败（HTTP ${response.status}）。`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('B 站音轨信息为空。');
    let text = '',
      size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) throw new Error('B 站音轨信息过大。');
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  try {
    if (location.href !== expectedUrl || !/(^|\.)bilibili\.com$/.test(location.hostname))
      throw new Error('视频页面已变化，请重新提取。');
    const query = /^av\d+$/i.test(videoId)
      ? `aid=${videoId.slice(2)}`
      : `bvid=${encodeURIComponent(videoId)}`;
    const view = await json(`https://api.bilibili.com/x/web-interface/view?${query}`);
    if (
      view.code !== 0 ||
      !view.data ||
      (/^av/i.test(videoId)
        ? String(view.data.aid) !== videoId.slice(2)
        : view.data.bvid !== videoId)
    )
      throw new Error('当前视频不可用或需要登录，无法获取音轨。');
    const current = view.data.pages?.find((item: { page: number }) => item.page === part);
    if (!current || !Number.isSafeInteger(current.cid) || current.cid <= 0)
      throw new Error('无法识别当前分 P 的音轨。');
    const play = await json(
      `https://api.bilibili.com/x/player/playurl?${query}&cid=${current.cid}&fnval=16&fnver=0&fourk=0`,
    );
    if (play.code !== 0 || !play.data)
      throw new Error('B 站未提供可下载音轨，请检查登录、视频访问权限或稍后重试。');
    const data = play.data;
    if (
      data.is_preview ||
      data.is_drm ||
      data.drm_tech_type ||
      data.accept_description?.some(
        (item: unknown) => typeof item === 'string' && item.includes('试看'),
      )
    )
      throw new Error('此视频只提供试看或受保护音轨，暂不支持转写。');
    const duration = Number(data.timelength) / 1000;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3600)
      throw new Error('音轨时长无效或超过首版 60 分钟上限。');
    if (typeof current.duration === 'number' && current.duration > duration + 3)
      throw new Error('音轨仅包含部分视频，无法作为完整内容转写。');
    const audios = (Array.isArray(data.dash?.audio) ? data.dash.audio : [])
      .filter(
        (item: any) =>
          item &&
          (item.mimeType || item.mime_type) === 'audio/mp4' &&
          Number.isFinite(item.bandwidth) &&
          item.bandwidth > 0,
      )
      .sort((a: any, b: any) => a.bandwidth - b.bandwidth);
    let audioUrl: string | undefined;
    for (const audio of audios) {
      const candidates = [
        audio.baseUrl || audio.base_url,
        ...(Array.isArray(audio.backupUrl || audio.backup_url)
          ? audio.backupUrl || audio.backup_url
          : []),
      ];
      for (const candidate of candidates) {
        try {
          const url = new URL(candidate);
          if (
            url.protocol === 'https:' &&
            !url.port &&
            !url.username &&
            !url.password &&
            !url.hash &&
            /(^|\.)(bilivideo\.com|bilivideo\.cn)$/.test(url.hostname)
          ) {
            audioUrl = url.href;
            break;
          }
        } catch {
          /* Skip invalid player/CDN addresses. */
        }
      }
      if (audioUrl) break;
    }
    if (!audioUrl) throw new Error('未找到受支持的 B 站 AAC 音轨。');
    if (location.href !== expectedUrl) throw new Error('获取音轨时视频已变化。');
    return {
      ok: true,
      data: { url: expectedUrl, videoId, part, cid: current.cid, duration, audioUrl },
    };
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? '获取 B 站音轨超时，请重试。'
        : error instanceof TypeError || error instanceof SyntaxError
          ? 'B 站音轨信息或网络异常，请刷新后重试。'
          : error instanceof Error
            ? error.message
            : '获取 B 站音轨失败。',
    };
  } finally {
    clearTimeout(timer);
  }
}
