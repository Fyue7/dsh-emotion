/**
 * dsh-emotion · 客户端半（会话头部情绪条）
 *
 * 形态照已在跑的 dsh-whale-pet / dsh-damage-pulse：`window.__ModuleLoader__.load` +
 * 裸 ESM、无构建步骤、只注册槽位、无顶层副作用（客户端加载失败会拖垮整个界面）。
 *
 * 数据来源是**宿主已有的会话投影通道**：组件从 `useSessions` 里按投影 key 读 wire 视图。
 * 本插件不注册任何 HTTP 路由。
 */

window.__ModuleLoader__.load({
	id: 'dsh-emotion',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require('react');

		var SLOT = 'conversation.session.header.actions';
		var PROJECTION_KEY = 'emotion';

		// 样式：全部走主题 token，明暗主题自动适配
		var css = [
			'.dshe-root{min-height:28px;display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border:0;border-radius:6px;background:0 0;cursor:default;font-size:12px;line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.dshe-root:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshe-root[data-tone="up"]{color:var(--dsw-alias-label-primary)}',
			'.dshe-root[data-tone="down"]{color:var(--dsw-alias-state-danger-primary)}',
			'.dshe-emoji{font-size:13px;line-height:1}',
			'.dshe-bar{display:inline-block;width:22px;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;vertical-align:middle}',
			'.dshe-bar > i{display:block;height:100%;background:currentColor}',
			'.dshe-low{opacity:.55}',
		].join('\n');

		var STYLE_TAG_ID = 'dsh-emotion/styles';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') === null) {
			var tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-emotion';
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** mood → emoji。情绪用符号表达，不播报数值。 */
		function emojiFor(mood) {
			if (mood >= 40) return '🙂';
			if (mood >= 10) return '🙂';
			if (mood > -10) return '😐';
			if (mood > -40) return '😕';
			return '😔';
		}

		function toneFor(mood) {
			if (mood >= 10) return 'up';
			if (mood <= -10) return 'down';
			return 'flat';
		}

		function EmotionBar(props) {
			var sessionId = props && props.sessionId;
			var useSessions = props && props.useSessions;

			var view = useSessions
				? useSessions(function (s) {
						var entry = s && s.byId ? s.byId[sessionId] : null;
						var values = entry ? entry.projectionValues : null;
						return values ? values[PROJECTION_KEY] : undefined;
					})
				: undefined;

			// 投影 store 建立前 projectionValues 是 undefined —— 必须判空后返回 null，
			// 不能崩掉整个会话头部
			if (!view) return null;

			var mood = typeof view.mood === 'number' ? view.mood : 0;
			var energy = typeof view.energy === 'number' ? view.energy : 0;
			var intensity = typeof view.intensity === 'number' ? view.intensity : 0;
			var label = view.label || '平静';
			var cause = view.cause || '';

			var tooltip =
				label +
				'｜心情 ' + (mood > 0 ? '+' : '') + mood +
				'（' + Math.round((mood + 100) / 2) + '%）· 能量 ' + energy +
				' · 第 ' + view.turn + ' 轮' +
				' · 强度 ' + intensity + '/3' +
				(cause ? '\n成因：' + cause : '');

			var children = [
				react.createElement('span', { className: 'dshe-emoji', key: 'e' }, emojiFor(mood)),
				react.createElement('span', { key: 'l' }, label),
				react.createElement('span', { className: 'dshe-bar', key: 'b' },
					react.createElement('i', { style: { width: Math.max(4, Math.min(100, (mood + 100) / 2)) + '%' } }),
				),
			];

			if (energy < 30) {
				children.push(react.createElement('span', { className: 'dshe-low', key: 'lo', title: '能量偏低' }, '🔋'));
			}

			return react.createElement('span', {
				className: 'dshe-root',
				'data-tone': toneFor(mood),
				title: tooltip,
				'aria-label': tooltip,
				children: children,
			});
		}

		var inject = ['slots'];

		function apply(ctx) {
			if (!ctx || !ctx.slots) return;
			try {
				ctx.slots.inject(SLOT, function () {
					return ctx.slots.register({ name: SLOT, id: 'emotion-bar', order: -5 }, EmotionBar);
				});
			} catch (error) {
				try {
					window.__dshEmotionError = String((error && error.message) || error);
				} catch (_) {}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
