/**
 * dsh-memory-probe — 浏览器半：「对话 / 轨迹」旁边的「记忆」标签页。
 *
 * 机制：
 *   window.__ModuleLoader__.load({ id, factory })   宿主加载器约定的模块格式
 *   ctx.slots.register({ name:"conversation.view", … , inject:(sessionId)=>({sessionId}) }, Component)
 *   —— conversation.view 是对话区顶部标签栏，轨迹插件同槽位、order 10
 *
 * 行为：
 *   1) 标签页跟随当前会话切换；iframe 的 src 带上 ?session=<id>
 *   2) 主题跟随 dsh：读 --dsw-alias-* 主题变量，postMessage 推给 iframe 实时换色；
 *      src 上再带一个 theme= 参数，保证首帧不闪
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-probe',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');

    /** dsh 主题暴露的 alias token（与 dsh-client-ui-theme 的 BUILTIN_INSPECT_TOKENS 一致）。 */
    const THEME_TOKENS = [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-state-idle-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-specific-sidebar-fill',
    ];

    /** 读当前主题变量的计算值（CSS 变量在 root 上，主题切换后值会变）。 */
    function readThemeTokens() {
      const out = {};
      try {
        const cs = getComputedStyle(document.documentElement);
        for (const name of THEME_TOKENS) {
          const v = cs.getPropertyValue(name).trim();
          if (v) out[name] = v;
        }
      } catch {
        /* 无 DOM 环境 */
      }
      return out;
    }

    /** 由底色亮度判断当前是浅色还是深色。 */
    function detectMode(tokens) {
      const bg = (tokens && tokens['--dsw-alias-bg-base']) || '';
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) {
        try {
          return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } catch {
          return 'light';
        }
      }
      const p = m[1].split(',').map(Number);
      const lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
      return lum > 0.5 ? 'light' : 'dark';
    }

    /** 会话 id → 面板地址（切换会话时 src 变化，iframe 自动重载到新会话）。 */
    function probeUrl(sessionId) {
      const base = '/memory-probe/';
      const sid = sessionId == null ? '' : String(sessionId);
      return sid ? `${base}?session=${encodeURIComponent(sid)}` : base;
    }

    function MemoryProbeView(props) {
      const sessionId = props && props.sessionId;
      const iframeRef = react.useRef(null);
      const src = probeUrl(sessionId);

      // 主题同步：iframe onLoad / dsh 主题变量变化 / 系统配色变化 → 推 tokens
      react.useEffect(() => {
        const push = () => {
          const tokens = readThemeTokens();
          const win = iframeRef.current && iframeRef.current.contentWindow;
          if (win) win.postMessage({ type: 'memory-probe:theme', tokens }, '*');
        };
        push();
        const mo = new MutationObserver(push);
        for (const el of [document.documentElement, document.body]) {
          if (el) mo.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-color-scheme'] });
        }
        let mq;
        try {
          mq = matchMedia('(prefers-color-scheme: dark)');
          mq.addEventListener('change', push);
        } catch {
          /* ignore */
        }
        return () => {
          mo.disconnect();
          if (mq) mq.removeEventListener('change', push);
        };
      }, [sessionId]);

      return react.createElement('iframe', {
        key: src,
        ref: iframeRef,
        src,
        title: '记忆',
        onLoad: () => {
          const tokens = readThemeTokens();
          const win = iframeRef.current && iframeRef.current.contentWindow;
          if (win) win.postMessage({ type: 'memory-probe:theme', tokens }, '*');
        },
        style: {
          width: '100%',
          height: '100%',
          minHeight: '320px',
          border: '0',
          display: 'block',
          background: 'transparent',
        },
      });
    }

    /** 注册标签页：order 30 = 排在「轨迹」(10) 之后；inject 提供当前会话 id。 */
    function apply(ctx) {
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'memory-probe',
            order: 30,
            label: () => '记忆',
            inject: (sessionId) => ({ sessionId }),
          },
          MemoryProbeView
        )
      );
    }

    const inject = ['slots'];

    exports.MemoryProbeView = MemoryProbeView;
    exports.probeUrl = probeUrl;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
