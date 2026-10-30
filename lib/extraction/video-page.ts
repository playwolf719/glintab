import type { RpcResponse, VideoPageResult, VideoPlatform } from '../../types';

// Chrome serializes this function for MAIN-world execution. Keep every runtime
// dependency inside it; never pass extension secrets or install page/network hooks.
export async function readVideoPage(
  platform: VideoPlatform,
  expectedUrl: string,
  videoId: string,
  part = 1,
): Promise<RpcResponse<VideoPageResult>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  type Track = {
    baseUrl?: string;
    subtitle_url?: string;
    languageCode?: string;
    lan?: string;
    kind?: string;
  };
  type Player = {
    videoDetails?: { videoId?: string; title?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
  };
  function allowed(raw: string, kind: 'youtube' | 'bilibili') {
    const url = new URL(raw, location.href);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      throw new Error('字幕地址无效，请刷新视频后重试。');
    const valid =
      kind === 'youtube'
        ? /(^|\.)youtube\.com$/.test(url.hostname) && url.pathname === '/api/timedtext'
        : /(^|\.)hdslb\.com$/.test(url.hostname) || url.hostname === 'subtitle.bilibili.com';
    if (!valid) throw new Error('字幕地址不属于受支持的平台。');
    return url;
  }
  async function download(url: string, credentials: RequestCredentials = 'include') {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials,
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error('字幕访问受限，请在视频网站登录、开启字幕并刷新后重试。');
      throw new Error(`字幕请求失败（HTTP ${response.status}），请稍后重试。`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('字幕响应为空，请开启播放器字幕后重试。');
    const decoder = new TextDecoder();
    let size = 0,
      text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4000000) throw new Error('字幕数据过大，暂时无法读取此视频。');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  function choose(tracks: Track[]) {
    // Prefer Chinese, then English, with manual captions first within each group.
    // do not request machine translation from either platform.
    const score = (t: Track) => {
      const language = (t.languageCode || t.lan || '').replace(/^ai-/, '');
      return (
        (/^zh|^cmn/.test(language) ? 100 : /^en/.test(language) ? 20 : 0) +
        (t.kind !== 'asr' && !t.lan?.startsWith('ai-') ? 10 : 0)
      );
    };
    return tracks
      .filter((t) => t && (t.baseUrl || t.subtitle_url))
      .sort((a, b) => score(b) - score(a))[0];
  }
  try {
    if (location.href !== expectedUrl) throw new Error('视频页面已变化，请重新提取。');
    let result: VideoPageResult;
    if (platform === 'youtube') {
      const host = location.hostname;
      if (!/(^|\.)youtube\.com$/.test(host)) throw new Error('视频来源不匹配。');
      const page = window as unknown as { ytInitialPlayerResponse?: Player };
      const player = document.getElementById('movie_player') as
        (HTMLElement & { getPlayerResponse?(): Player }) | null;
      let response = player?.getPlayerResponse?.();
      if (response?.videoDetails?.videoId !== videoId) response = page.ytInitialPlayerResponse;
      if (response?.videoDetails?.videoId !== videoId)
        throw new Error('播放器尚未加载当前视频，请等待加载完成或刷新后重试。');
      const track = choose(response.captions?.playerCaptionsTracklistRenderer?.captionTracks || []);
      if (!track?.baseUrl) throw new Error('此 YouTube 视频没有可读取的字幕，暂时无法总结。');
      const url = allowed(track.baseUrl, 'youtube');
      if (url.searchParams.get('v') && url.searchParams.get('v') !== videoId)
        throw new Error('字幕与当前视频不匹配，请刷新后重试。');
      url.searchParams.set('fmt', 'json3');
      // An already requested player URL may carry the current subtitle token.
      const candidates = [url.href];
      for (const resource of performance.getEntriesByType('resource').slice(-200)) {
        try {
          const recent = allowed(resource.name, 'youtube');
          if (
            recent.searchParams.get('v') === videoId &&
            recent.searchParams.get('lang') === url.searchParams.get('lang') &&
            ['kind', 'name', 'tlang'].every(
              (key) => recent.searchParams.get(key) === url.searchParams.get(key),
            )
          ) {
            recent.searchParams.set('fmt', 'json3');
            if (!candidates.includes(recent.href)) candidates.unshift(recent.href);
          }
        } catch {
          /* unrelated page resources */
        }
      }
      let body = '',
        lastError: unknown;
      for (const candidate of candidates.slice(0, 3)) {
        try {
          body = await download(candidate);
          if (body.trim()) break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!body.trim())
        throw lastError || new Error('字幕响应为空，请开启播放器字幕并刷新后重试。');
      let format: VideoPageResult['format'] = 'youtube-json3';
      if (body.trim().startsWith('<')) {
        const doc = new DOMParser().parseFromString(body, 'text/xml');
        if (doc.querySelector('parsererror') || !doc.querySelector('transcript, timedtext'))
          throw new Error('字幕格式无效，请刷新视频后重试。');
        const segments = [...doc.querySelectorAll('text, p')].map((node) => {
          const milliseconds = node.tagName === 'p';
          const start =
            Number(node.getAttribute(milliseconds ? 't' : 'start') ?? NaN) /
            (milliseconds ? 1000 : 1);
          const duration =
            Number(node.getAttribute(milliseconds ? 'd' : 'dur') ?? NaN) /
            (milliseconds ? 1000 : 1);
          return { start, end: start + duration, text: node.textContent || '' };
        });
        body = JSON.stringify(segments);
        format = 'segments';
      }
      result = {
        url: expectedUrl,
        videoId,
        title: response.videoDetails?.title || document.title,
        language: track.languageCode || 'und',
        automatic: track.kind === 'asr',
        format,
        body,
      };
    } else {
      if (!/(^|\.)bilibili\.com$/.test(location.hostname)) throw new Error('视频来源不匹配。');
      // Fetch current metadata by URL instead of trusting stale SPA initial state.
      const query = /^av\d+$/i.test(videoId)
        ? `aid=${videoId.slice(2)}`
        : `bvid=${encodeURIComponent(videoId)}`;
      const view = JSON.parse(
        await download(`https://api.bilibili.com/x/web-interface/view?${query}`),
      ) as {
        code?: number;
        data?: {
          bvid?: string;
          aid?: number;
          title?: string;
          pages?: { cid: number; page: number; part: string }[];
        };
      };
      if (
        view.code !== 0 ||
        !view.data ||
        (/^av/i.test(videoId)
          ? String(view.data.aid) !== videoId.slice(2)
          : view.data.bvid !== videoId)
      )
        throw new Error('无法获取当前视频信息，可能需要登录或视频不可用，请刷新后重试。');
      const current = view.data.pages?.find((item) => item.page === part);
      if (!current || !Number.isSafeInteger(current.cid) || current.cid <= 0)
        throw new Error('无法识别当前分 P，请打开具体分 P 并刷新后重试。');
      const metadata = JSON.parse(
        await download(`https://api.bilibili.com/x/player/wbi/v2?${query}&cid=${current.cid}`),
      ) as {
        code?: number;
        data?: { cid?: number; need_login_subtitle?: boolean; subtitle?: { subtitles?: Track[] } };
      };
      if (metadata.code !== 0 || !metadata.data)
        throw new Error('B 站字幕接口暂不可用，请登录、开启字幕并刷新后重试。');
      if (metadata.data.cid !== undefined && metadata.data.cid !== current.cid)
        throw new Error('字幕与当前分 P 不匹配，请刷新后重试。');
      if (!Array.isArray(metadata.data.subtitle?.subtitles) && !metadata.data.need_login_subtitle)
        throw new Error('B 站字幕列表格式无效，未启动音轨转写，请刷新后重试。');
      const track = choose(metadata.data.subtitle?.subtitles || []);
      if (!track?.subtitle_url) {
        if (metadata.data.need_login_subtitle)
          throw new Error('此视频字幕需要登录 B 站，请登录并刷新后重试。');
        if (metadata.data.subtitle!.subtitles!.length)
          throw new Error('B 站字幕轨道地址无效，未启动音轨转写，请刷新后重试。');
        return {
          ok: true,
          data: {
            url: expectedUrl,
            videoId,
            part,
            title: `${view.data.title || document.title}${(view.data.pages?.length || 0) > 1 ? ` · P${part} ${current.part}` : ''}`,
            language: 'und',
            automatic: true,
            format: 'bilibili-audio-required',
            body: '',
          },
        };
      }
      const url = allowed(track.subtitle_url, 'bilibili');
      const captions = JSON.parse(await download(url.href, 'omit')) as {
        body?: { from: number; to: number; content: string }[];
      };
      if (!Array.isArray(captions.body)) throw new Error('B 站字幕格式无效，请刷新后重试。');
      result = {
        url: expectedUrl,
        videoId,
        part,
        title: `${view.data.title || document.title}${(view.data.pages?.length || 0) > 1 ? ` · P${part} ${current.part}` : ''}`,
        language: track.lan || 'und',
        automatic: !!track.lan?.startsWith('ai-'),
        format: 'segments',
        body: JSON.stringify(
          captions.body.map((item) => ({ start: item.from, end: item.to, text: item.content })),
        ),
      };
    }
    if (location.href !== expectedUrl) throw new Error('提取过程中视频已变化，请重新提取。');
    return { ok: true, data: result };
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? '字幕提取超时，请等待视频加载或开启字幕后重试。'
        : error instanceof TypeError || error instanceof SyntaxError
          ? '字幕请求或格式异常，请检查网络、登录状态并刷新视频后重试。'
          : error instanceof Error
            ? error.message
            : '字幕提取失败，请刷新后重试。',
    };
  } finally {
    clearTimeout(timer);
  }
}
