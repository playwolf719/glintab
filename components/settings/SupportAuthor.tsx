import { Download, ExternalLink, Heart } from 'lucide-react';
import supportQr from '../../assets/support-qr.jpg';

export function SupportAuthor() {
  return (
    <section aria-labelledby="support-heading">
      <div className="page-heading">
        <h1 id="support-heading">支持作者</h1>
        <p>如果 Glintab 帮你读懂了更多内容，欢迎支持它继续成长。</p>
      </div>
      <div className="support-layout">
        <div className="support-copy">
          <Heart size={28} aria-hidden="true" />
          <h2>请作者喝杯咖啡</h2>
          <p>Glintab 免费使用。打赏完全自愿，不会解锁额外功能，也不影响任何功能的使用。</p>
          <p>用微信扫描收款码，自行选择金额。付款前请核对收款人信息，感谢你的支持。</p>
          <p className="muted">
            付款在微信中完成。扩展不读取付款账号、金额或交易记录，也不会检查你是否打赏。
          </p>
          <a href="mailto:playwolf719@gmail.com">联系作者：playwolf719@gmail.com</a>
        </div>
        <figure className="support-qr">
          <img src={supportQr} width={828} height={1124} alt="Glintab 作者的微信自愿打赏收款码" />
          <figcaption>微信扫码，自愿选择金额</figcaption>
          <div className="support-actions">
            <a
              className="button secondary"
              href={supportQr}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={15} aria-hidden="true" />
              查看原图
            </a>
            <a className="button secondary" href={supportQr} download="Glintab-微信打赏.jpg">
              <Download size={15} aria-hidden="true" />
              保存收款码
            </a>
          </div>
        </figure>
      </div>
    </section>
  );
}
