/**
 * dsh-emotion · Host 半
 *
 * 三个注册面（对应设计文档 §3.2）：
 *   1. `ctx.sessionProjections.register` —— 情绪状态机本体（宿主负责持久化与驱动）
 *   2. `ctx.systemPrompt.section`        —— 静态规则段 + 动态状态段
 *   3. `ctx.commands.register`           —— `/mood` 命令族（v1 的配置入口，不写设置页）
 *
 * 另有一个**必要**的例外：`ctx.on('session/event')` 仅用于推进跨会话的 `closeness`。
 * 投影的 `apply` 是逐会话的纯函数，装不下跨会话写入；这一条无法由投影承担。
 */

import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

import { objectSchema, hasZod, zodLoadError } from './schema.js';
import {
	PROJECTION_KEY,
	STATE_VERSION,
	applyEvent,
	causeOf,
	describeMood,
	initState,
	intensityOf,
	labelOf,
} from './state.js';
import {
	RULES_ORDER,
	RULES_SECTION,
	STATE_ORDER,
	STATE_SECTION,
	compileRules,
	compileState,
} from './prompt.js';
import { loadStyleProfile, renderStyle } from './style.js';
import { createClosenessStore } from './store.js';

const name = 'emotion';
const inject = ['systemPrompt', 'sessionProjections'];

/** 亲密度：每次正常收尾 +1.5，上限 100（由 store 收敛）。 */
const CLOSENESS_PER_TURN = 1.5;

/** 用户可调配置。字段标 `.volatile()` 才会出现在设置里并写回 profile patch。 */
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	intensity: z.union([z.const('low'), z.const('mid'), z.const('high')]).default('mid').volatile(),
	styleBias: z.union([z.const('restrained'), z.const('balanced'), z.const('outgoing')]).default('balanced').volatile(),
	styleProfile: z.union([z.const('auto'), z.const('off')]).default('auto').volatile(),
});

/* ------------------------------------------------------------------ 工具 */

/**
 * 读配置项。
 *
 * 宿主 `Config` 字段可能是**引用**（有 `.get()`）也可能是普通值，取决于挂载路径；
 * 两种都容忍，读不到就用默认值 —— 不让配置形态差异把插件搞挂。
 */
function readConfig(config, key, fallback) {
	const raw = config?.[key];
	if (raw === undefined || raw === null) return fallback;
	if (typeof raw === 'object') {
		if (typeof raw.get === 'function') {
			try {
				const value = raw.get();
				return value === undefined || value === null ? fallback : value;
			} catch {
				return fallback;
			}
		}
		if ('value' in raw) return raw.value ?? fallback;
	}
	return raw;
}

/** HOME 取不到时返回 undefined —— 加载器会退回内置档案。 */
function emotionHome() {
	try {
		return dshHomePath('dsh-emotion');
	} catch {
		return undefined;
	}
}

const INTENSITY_SHIFT = { low: -1, mid: 0, high: 1 };

function clampBand(value) {
	return value < 0 ? 0 : value > 3 ? 3 : value;
}

/* ------------------------------------------------------------------ 投影 schema */

const stateSchema = objectSchema(
	['mood', 'energy', 'turn', 'streakOk', 'streakFail', 'lastKind', 'lastDelta'],
	(zd) =>
		zd.object({
			mood: zd.number(),
			energy: zd.number(),
			turn: zd.number().int(),
			streakOk: zd.number().int(),
			streakFail: zd.number().int(),
			lastKind: zd.string(),
			lastDelta: zd.number(),
		}),
);

const viewSchema = objectSchema(
	['mood', 'energy', 'turn', 'label', 'cause', 'intensity'],
	(zd) =>
		zd.object({
			mood: zd.number(),
			energy: zd.number(),
			turn: zd.number().int(),
			label: zd.string(),
			cause: zd.string(),
			intensity: zd.number().int(),
		}),
);

/* ------------------------------------------------------------------ 插件本体 */

function apply(ctx, config) {
	const home = emotionHome();
	const style = loadStyleProfile({ homePath: home });
	const closeness = createClosenessStore(home ?? '.');

	/** v1 没有设置页，命令是配置入口；这里放运行时覆盖（优先于 Config，不落盘）。 */
	const override = { enabled: undefined, intensity: undefined, styleBias: undefined, styleProfile: undefined };

	/**
	 * 本会话手动调整量。
	 *
	 * 为什么是「偏移」而不是「直接改状态」：`ctx.sessionProjections` **没有写入 API**
	 * （只有 register/stateOf/snapshot/checkpoint/restore/hydrate），
	 * 且 `stateOf` 明确要求调用者不得修改返回值。所以 `/mood set` 只能作用于编译期。
	 */
	const manualOffset = new Map();

	function conf(key, fallback) {
		const over = override[key];
		if (over !== undefined) return over;
		return readConfig(config, key, fallback);
	}

	function bandFor(state) {
		const base = intensityOf(state);
		const shift = INTENSITY_SHIFT[conf('intensity', 'mid')] ?? 0;
		return clampBand(base + shift);
	}

	function styleText() {
		if (!style) return '';
		if (conf('styleProfile', 'auto') === 'off') return '';
		return renderStyle(style.profile, conf('styleBias', 'balanced'));
	}

	function renderRules() {
		if (!conf('enabled', true)) return '';
		return compileRules({ styleText: styleText() });
	}

	function renderStateFor(context) {
		if (!conf('enabled', true)) return '';
		const session = context?.agent?.session;
		if (!session) return '';
		let state;
		try {
			state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
		} catch {
			return '';
		}
		if (!state) return '';
		const offset = manualOffset.get(session.id) ?? { mood: 0, energy: 0 };
		const adjusted = {
			...state,
			mood: state.mood + (offset.mood ?? 0),
			energy: state.energy + (offset.energy ?? 0),
		};
		return compileState({
			state: adjusted,
			closeness: closeness.get(),
			intensity: bandFor(adjusted),
			styleBias: conf('styleBias', 'balanced'),
		});
	}

	/* --- 1. 状态机（会话投影：宿主负责驱动、持久化、发给客户端） --- */
	let lastViewState = null;
	let lastView = null;

	ctx.sessionProjections.register({
		key: PROJECTION_KEY,
		stateVersion: STATE_VERSION,
		stateSchema,
		init: () => initState(),
		apply: applyEvent,
		wire: {
			viewSchema,
			view(state) {
				// 同一状态引用必须复用视图引用，否则会无谓地触发发布
				if (state === lastViewState && lastView) return lastView;
				lastViewState = state;
				lastView = {
					mood: state.mood,
					energy: state.energy,
					turn: state.turn,
					label: labelOf(state),
					cause: causeOf(state),
					intensity: intensityOf(state),
				};
				return lastView;
			},
		},
	});

	/* --- 2. 提示词两段 --- */
	ctx.systemPrompt.section({
		name: RULES_SECTION,
		order: RULES_ORDER,
		text: () => renderRules(),
	});

	ctx.systemPrompt.section({
		name: STATE_SECTION,
		order: STATE_ORDER,
		text: (context) => renderStateFor(context),
	});

	/* --- 跨会话亲密度：投影装不下，必须自己听事件 --- */
	ctx.on('session/event', (session, event) => {
		if (!conf('enabled', true)) return;
		if (event?.type !== 'turn/end') return;
		if (event.data?.reason?.kind !== 'completed') return;
		closeness.bump(CLOSENESS_PER_TURN);
	});

	/* --- 3. `/mood` 命令族（可选依赖，拿不到就不注册） --- */
	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			name: 'mood',
			description: '查看/调整情绪状态与配置（on|off|why|reset|intensity=…|style=…|profile=…|mood=…|energy=…）',
			input: { hint: '[on|off|why|reset|intensity=low|style=outgoing|profile=off|mood=20|energy=80]' },
			handler: (invocation) => handleMood(invocation),
		});
	});

	function handleMood(invocation) {
		const session = invocation.agent?.session;
		const arg = String(invocation.rawInput ?? '').trim();

		if (arg === 'off' || arg === 'on') {
			override.enabled = arg === 'on';
			return {
				kind: 'success',
				text:
					`情绪已${arg === 'on' ? '开启' : '关闭'}（运行时覆盖，重启后回到配置值）。\n` +
					(arg === 'off'
						? '两个情绪段都不再注入，行为与官方一致。'
						: '两个情绪段恢复注入。'),
			};
		}

		if (arg === 'why') {
			const rules = renderRules();
			const state = session ? renderStateFor({ agent: { session } }) : '';
			return {
				kind: 'success',
				text:
					`— ${RULES_SECTION}（order ${RULES_ORDER}）—\n${rules || '（空：未注入）'}\n\n` +
					`— ${STATE_SECTION}（order ${STATE_ORDER}）—\n${state || '（空：未注入）'}`,
			};
		}

		if (arg === 'reset') {
			if (session) manualOffset.delete(session.id);
			return { kind: 'success', text: '本会话的手动调整已清除（投影状态本身不可写，故不会被重置）。' };
		}

		const assignments = arg
			.split(/\s+/)
			.filter(Boolean)
			.map((token) => {
				const idx = token.indexOf('=');
				return idx === -1 ? [token, ''] : [token.slice(0, idx), token.slice(idx + 1)];
			});

		const applied = [];
		const rejected = [];

		for (const [rawKey, value] of assignments) {
			const key = rawKey.toLowerCase();
			switch (key) {
				case 'intensity':
					if (['low', 'mid', 'high'].includes(value)) {
						override.intensity = value;
						applied.push(`intensity=${value}`);
					} else rejected.push(`${key}=${value}（只接受 low|mid|high）`);
					break;
				case 'style':
					if (['restrained', 'balanced', 'outgoing'].includes(value)) {
						override.styleBias = value;
						applied.push(`styleBias=${value}`);
					} else rejected.push(`${key}=${value}（只接受 restrained|balanced|outgoing）`);
					break;
				case 'profile':
					if (['auto', 'off'].includes(value)) {
						override.styleProfile = value;
						applied.push(`styleProfile=${value}`);
					} else rejected.push(`${key}=${value}（只接受 auto|off）`);
					break;
				case 'mood':
				case 'energy': {
					const num = Number(value);
					if (!Number.isFinite(num)) {
						rejected.push(`${key}=${value}（需要一个数字）`);
						break;
					}
					if (!session) {
						rejected.push(`${key}（当前没有会话，无法调整）`);
						break;
					}
					const current = manualOffset.get(session.id) ?? { mood: 0, energy: 0 };
					// 语义是「临时调整量」，不是绝对赋值 —— 投影状态本身不可写
					current[key] = key === 'mood' ? Math.max(-100, Math.min(100, num)) : Math.max(-100, Math.min(100, num));
					manualOffset.set(session.id, current);
					applied.push(`${key} 调整量=${num}`);
					break;
				}
				default:
					rejected.push(rawKey);
			}
		}

		const lines = [];
		if (applied.length) lines.push(`已生效：${applied.join('、')}`);
		if (rejected.length) lines.push(`未识别/不合法：${rejected.join('、')}`);
		if (!applied.length && !rejected.length) lines.push(statusText(session));
		else lines.push('', statusText(session));
		return { kind: rejected.length && !applied.length ? 'error' : 'success', text: lines.join('\n') };
	}

	function statusText(session) {
		const enabled = conf('enabled', true);
		const lines = [];

		lines.push(`情绪插件：${enabled ? '已开启' : '已关闭'}`);
		lines.push(
			`配置：intensity=${conf('intensity', 'mid')} · styleBias=${conf('styleBias', 'balanced')} · ` +
				`styleProfile=${conf('styleProfile', 'auto')}`,
		);

		if (session) {
			let state = null;
			try {
				state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
			} catch {
				state = null;
			}
			if (state) {
				const offset = manualOffset.get(session.id);
				const mood = state.mood + (offset?.mood ?? 0);
				const energy = state.energy + (offset?.energy ?? 0);
				lines.push(
					`本会话：心情 ${mood > 0 ? '+' : ''}${mood}（${describeMood(mood)}）· 能量 ${energy} · ` +
						`第 ${state.turn} 轮 · 连续失败 ${state.streakFail}`,
				);
				lines.push(`基调：${labelOf(state)}｜成因：${causeOf(state)}｜强度档 ${bandFor(state)}/3`);
				if (offset) lines.push(`手动调整量：mood ${offset.mood ?? 0} · energy ${offset.energy ?? 0}`);
			} else {
				lines.push('本会话：状态尚未物化（投影 key 未注册时返回 undefined）');
			}
		} else {
			lines.push('本会话：（命令未关联到会话）');
		}

		lines.push(`亲密度：${closeness.get()}（跨会话，存于 ${closeness.file}）`);
		lines.push(
			style
				? `风格档案：${style.profile.source ?? '未标注'} ← ${style.path}（样例 ${(style.profile.samples ?? []).length} 段）`
				: '风格档案：未找到，只注入情绪规则（降级）',
		);
		lines.push(`schema 校验：${hasZod ? 'zod（完整）' : `降级 shim —— ${zodLoadError?.message ?? '未知原因'}`}`);
		lines.push('');
		lines.push('用法：/mood on|off|why|reset|intensity=low|style=outgoing|profile=off|mood=20|energy=80');

		return lines.join('\n');
	}
}

export { Config, apply, inject, name };
