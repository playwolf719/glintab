import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  // Injection is explicitly coordinated by background, never registered globally.
  matches: [],
  registration: 'runtime',
  main(ctx) {
    const hostId = 'glintab-drawer-host';
    if (document.getElementById(hostId)) return;
    const host = document.createElement('div');
    host.id = hostId;
    host.dataset.glintabHost = '';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial!important;position:fixed!important;inset:0 0 0 auto!important;z-index:2147483647!important;display:block!important;width:var(--glintab-width,420px)!important;pointer-events:none!important}:host([data-open]){pointer-events:auto!important}.drawer{position:absolute;top:0;height:100dvh;width:100%;max-width:100vw;background:#fff;box-shadow:-8px 0 38px #15304d1c;right:-105%;transition:right .22s;pointer-events:none;border-left:1px solid #dce4ed}.drawer.open{right:0;pointer-events:auto}iframe{border:0;width:100%;height:100%;display:block;pointer-events:auto}.handle{position:absolute;left:-4px;top:0;width:8px;height:100%;cursor:ew-resize}.handle:hover{background:#497ee944}@media(prefers-reduced-motion:reduce){.drawer{transition:none}}`;
    const drawer = document.createElement('div');
    drawer.className = 'drawer';
    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.title = '拖动调整宽度，双击恢复';
    const frame = document.createElement('iframe');
    frame.title = 'Glintab 网页阅读助手';
    frame.allow = 'clipboard-write';
    drawer.append(frame, handle);
    shadow.append(style, drawer);
    document.documentElement.append(host);
    let open = false,
      width = 420;
    const clamp = (value: number) =>
      Math.max(
        Math.min(280, innerWidth),
        Math.min(value, Math.min(760, Math.max(280, innerWidth - 160))),
      );
    const applyWidth = () =>
      host.style.setProperty('--glintab-width', `${clamp(width)}px`, 'important');
    function setOpen(value: boolean) {
      open = value;
      host.toggleAttribute('data-open', open);
      drawer.classList.toggle('open', open);
      if (open && !frame.getAttribute('src'))
        void chrome.runtime
          .sendMessage({ channel: 'glintab:drawer-source' })
          .then((response) => {
            if (!response.ok) throw new Error('无法获取标签页。');
            const { tabId, width: savedWidth } = response.data;
            width = Number(savedWidth) || 420;
            applyWidth();
            frame.src = chrome.runtime.getURL('/sidepanel.html') + `?tabId=${tabId}&mode=drawer`;
          })
          .catch(() => host.remove());
    }
    applyWidth();
    const listener = (
      message: { channel?: string; open?: boolean },
      sender: chrome.runtime.MessageSender,
      respond: (value: unknown) => void,
    ) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message.channel === 'glintab:drawer') {
        setOpen(message.open ?? !open);
        respond({ open });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      frame.style.pointerEvents = 'none';
      const move = (e: PointerEvent) => {
        width = clamp(innerWidth - e.clientX);
        applyWidth();
      };
      const end = () => {
        frame.style.pointerEvents = '';
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        void chrome.runtime.sendMessage({ channel: 'glintab:drawer-width', width }).catch(() => {});
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('dblclick', () => {
      width = 420;
      applyWidth();
      void chrome.runtime.sendMessage({ channel: 'glintab:drawer-width', width });
    });
    const resize = () => {
      applyWidth();
    };
    window.addEventListener('resize', resize);
    ctx.onInvalidated(() => {
      host.remove();
      window.removeEventListener('resize', resize);
      chrome.runtime.onMessage.removeListener(listener);
    });
  },
});
