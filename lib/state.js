/**
 * dsh-emotion · 情绪状态机（纯函数）
 *
 * 纪律（来自 dsh-session-projection 官方约束，违反会导致性能或正确性问题）：
 *   1. `applyEvent` 必须同步；
 *   2. 对无关事件**必须返回同一个状态引用** —— 注册表用 `Object.is` 做第一层闸门，
 *      引用不变即零下游工作；
 *   3. 携带状态的日志事件必须携带**变更后的完整状态**，绝不携带裸增量。
 *
 * 本模块无 IO、无时间依赖，因此可脱离宿主完整单测。
 */

/** 状态字段或折叠语义变化时必须递增（宿主冷读会丢弃 ver 不匹配的持久行）。 */
export const STATE_VERSION = 1;

/** 会话投影 key。 */
export const PROJECTION_KEY = 'emotion';

/** 状态区间。 */
export const MOOD_MIN = -100;
export const MOOD_MAX = 100;
export const ENERGY_MIN = 0;
export const ENERGY_MAX = 100;

export function clamp(value, lo, hi) {
	return value < lo ? lo : value > hi ? hi : value;
}

/** 每会话初值。必须是 plain JSON（投影会做 structuredClone）。 */
export function initState() {
	return {
		mood: 0,
		energy: 70,
		turn: 0,
		streakOk: 0,
		streakFail: 0,
		lastKind: 'session-start',
		lastDelta: 0,
	};
}

/**
 * 判定一次 `tool/result` 是否失败。
 *
 * ⚠️ 宿主真实类型是 `SessionEventMap['tool/result'] = { turn, step, message, error?, meta? }`，
 * `isError` 挂在 **message** 上（`ToolResultMessage.isError`）。写成 `event.data.isError`
 * 会让失败分支永远不触发 —— 这是照抄二手文档最容易踩的坑。
 */
export function toolResultFailed(data) {
	if (!data || typeof data !== 'object') return false;
	if (data.error !== undefined && data.error !== null) return true;
	return data.message?.isError === true;
}

/** 连续受阻阈值：达到即判定为「卡住了」。 */
export const BLOCKED_STREAK = 3;

/**
 * 折叠一个事件，返回**新状态或原引用**。
 */
export function applyEvent(state, event) {
	const type = event?.type;
	const data = event?.data;

	switch (type) {
		case 'tool/result': {
			if (toolResultFailed(data)) {
				let next = {
					...state,
					mood: clamp(state.mood - 4, MOOD_MIN, MOOD_MAX),
					streakFail: state.streakFail + 1,
					streakOk: 0,
					lastKind: 'tool-fail',
					lastDelta: -4,
				};
				if (next.streakFail >= BLOCKED_STREAK) {
					next = {
						...next,
						mood: clamp(next.mood - 8, MOOD_MIN, MOOD_MAX),
						energy: clamp(next.energy - 15, ENERGY_MIN, ENERGY_MAX),
						lastKind: 'blocked',
						lastDelta: -12,
					};
				}
				return next;
			}
			return {
				...state,
				mood: clamp(state.mood + 2, MOOD_MIN, MOOD_MAX),
				streakOk: state.streakOk + 1,
				streakFail: 0,
				lastKind: 'tool-ok',
				lastDelta: 2,
			};
		}

		case 'llm/retry':
		case 'llm/retry-started':
			return {
				...state,
				mood: clamp(state.mood - 3, MOOD_MIN, MOOD_MAX),
				lastKind: 'llm-retry',
				lastDelta: -3,
			};

		case 'turn/end': {
			const kind = data?.reason?.kind ?? 'unknown';
			const delta = kind === 'completed' ? 3 : kind === 'error' ? -6 : 0;
			return {
				...state,
				turn: state.turn + 1,
				energy: clamp(state.energy - 2, ENERGY_MIN, ENERGY_MAX),
				mood: clamp(state.mood + delta, MOOD_MIN, MOOD_MAX),
				lastKind: `turn-${kind}`,
				lastDelta: delta,
			};
		}

		case 'turn/start':
			// 只作轻微唤醒，不改变 mood，避免每轮都造新对象带来的无谓下游工作
			if (state.energy >= ENERGY_MAX) return state;
			return { ...state, energy: clamp(state.energy + 1, ENERGY_MIN, ENERGY_MAX) };

		default:
			// ← 必须返回同一引用（官方自己的投影也是这么写的）
			return state;
	}
}

/** 情绪强度 0..3：由 mood 幅度与连续受阻共同决定。 */
export function intensityOf(state) {
	if (state.streakFail >= BLOCKED_STREAK) return 3;
	const m = Math.abs(state.mood);
	if (m >= 40) return 3;
	if (m >= 18) return 2;
	if (m >= 6) return 1;
	return 0;
}

/**
 * 单一离散情绪标签。
 *
 * 说明：这是**助手自身**的状态标签，只用于状态文字与 UI。
 * **用户的情绪不由本地规则猜测** —— 那交给主模型在思维链里判断（设计文档 §4.2 的分工）。
 */
export function labelOf(state) {
	if (state.streakFail >= BLOCKED_STREAK) return state.mood <= -40 ? '有点烦' : '有点丧';
	switch (state.lastKind) {
		case 'tool-fail':
			return '有点丧';
		case 'llm-retry':
			return '有点烦';
		case 'tool-ok':
			return state.streakOk >= 5 ? '来劲了' : '还行';
		case 'turn-completed':
			return state.mood >= 20 ? '轻快' : '还行';
		case 'turn-error':
			return '有点沉';
		default:
			break;
	}
	if (state.energy <= 25) return '有点累';
	if (state.mood >= 30) return '轻快';
	if (state.mood <= -30) return '有点沉';
	if (state.mood >= 10) return '平和';
	if (state.mood <= -10) return '有点低';
	return '平静';
}

/** 能量/心情的自然语言补充（给 UI tooltip 与状态段用）。 */
export function describeMood(mood) {
	if (mood >= 40) return '明显偏正向';
	if (mood >= 10) return '略偏正向';
	if (mood > -10) return '基本中性';
	if (mood > -40) return '略偏低沉';
	return '明显偏低沉';
}

/** 事件 kind → 中文成因，供 UI tooltip 与状态段使用。 */
export function causeOf(state) {
	switch (state.lastKind) {
		case 'tool-fail':
			return '刚才有个操作没成功';
		case 'blocked':
			return `连续受阻（${state.streakFail} 次操作失败）`;
		case 'tool-ok':
			return '操作顺利';
		case 'llm-retry':
			return '模型请求重试了一次';
		case 'turn-completed':
			return '上一轮正常收尾';
		case 'turn-error':
			return '上一轮出错了';
		case 'turn-aborted':
			return '上一轮被中断';
		case 'session-start':
			return '会话开始';
		default:
			return state.lastKind?.startsWith('turn-')
				? `上一轮结束（${state.lastKind.slice(5)}）`
				: '最近没有特别的变化';
	}
}
