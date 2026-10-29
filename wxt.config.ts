import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: 'output',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Glintab · 网页阅读助手',
    description: '用自己的 AI 模型，理解当前网页、提炼重点并持续追问。数据保存在本机。',
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'offscreen',
      'sidePanel',
      'tabs',
      'alarms',
      'webNavigation',
    ],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: '打开 Glintab' },
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    web_accessible_resources: [
      {
        resources: ['sidepanel.html', 'chunks/*', 'assets/*'],
        matches: ['http://*/*', 'https://*/*'],
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; base-uri 'self';",
    },
  },
});
