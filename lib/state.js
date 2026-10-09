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
 *
 * ── v3 的两处实质改动（都是被实测逼出来的）─────────────────────────────
 *
 * 1. **心情改成事件级的指数回归**，不再「成功 +2、只在轮末砍半」。
 *    旧模型下，一轮里调 50 次工具（长任务很正常）就把 mood 顶到 +96，
 *    之后每轮注入的状态段都是同一行字 —— 等于没注入。改成每来一个事件就拉一次：
 *
 *        mood ← mood + target - mood × pull
 *
 *    稳态由**事件的性质**决定（连续成功 ≈ +25，连续失败 ≈ -40），
 *    而不是由「这一轮调了多少次工具」决定。轮末再回归一次，给每轮一个起点。
 *
 * 2. **新增「本轮实况」素材**：`toolCalls` / `files` / `failed`。
 *    它们只记录真发生过的事（调用次数、动过的文件短路径、失败次数），
 *    供提示词里的实况段使用。**没有素材就不许提关系**这条硬约束靠它兜底：
 *    素材为空时实况段就是空的，模型手里没有可编的原料。
 */

/** 状态字段或折叠语义变化时必须递增（宿主冷读会丢弃 ver 不匹配的持久行）。 */
// v3：事件级指数回归 + 本轮实况（toolCalls/files/failed）。折叠语义又变了。
export const STATE_VERSION = 3;

/** 会话投影 key。 */
export const PROJECTION_KEY = 'emotion';

/** 状态区间。 */
export const MOOD_MIN = -100;
export const MOOD_MAX = 100;
export const ENERGY_MIN = 0;
export const ENERGY_MAX = 100;

/** 能量基线：轮末往这里回。 */
export const ENERGY_BASE = 70;

/** 每调一次工具的精力开销，以及轮末的恢复比例。 */
export const ENERGY_PER_CALL = 1;
export const ENERGY_RECOVER = 0.35;

/** 指数回归的参数：每次成功/失败把心情往目标值拉多少。 */
export const MOOD_TARGET_OK = 2;
export const MOOD_PULL_OK = 0.08;
export const MOOD_TARGET_FAIL = -4;
export const MOOD_PULL_FAIL = 0.1;

/**
 * 轮末再回归一次的比例。
 *
 * 事件级回归已经保证不饱和了，这一下是为了**给每轮一个可见的起点**：
 * 上一轮的糟心事不该原封不动地压到下一轮开头。
 */
export const MOOD_REVERSION = 0.5;

/** 本轮实况最多记几个文件。多了污染提示词，也没有额外信息。 */
export const MAX_FILES = 3;

/** 会改动文件的工具。只记这几个 —— `read`/`grep` 走过一百个文件也不代表在做这件事。 */
export const FILE_TOOLS = ['edit', 'write'];

export function clamp(value, lo, hi) {
	return value < lo ? lo : value > hi ? hi : value;
}

/**
 * 事件级的指数回归：朝 target 走一步，越接近它步子越小。
 *
 * 取整是有意的：这段数值最终会进提示词，`+22.97800615166195` 既难看又白烧 token，
 * 而阈值判断（强度档、基调标签）本来也不需要小数。取整发生在**每一步**，
 * 因此状态里存的、落盘的、注入的永远是同一个整数，不会出现「显示值 ≠ 状态值」。
 */
function pullMood(mood, target, pull) {
	return clamp(Math.round(mood + target - mood * pull), MOOD_MIN, MOOD_MAX);
}

/**
 * 路径 → 末两段。
 *
 * 只留末两段是有意的：`lib/state.js` 比 `state.js` 有辨识度，又比
 * `E:\agent\projects\dsh-emotion\lib\state.js` 省一半长度。纯字符串处理，
 * 不碰盘、不猜目录。
 */
export function shortPath(input) {
	const parts = String(input ?? '')
		.split(/[\\/]+/)
		.filter((p) => p && p !== '.');
	if (!parts.length) return '';
	return parts.slice(-2).join('/');
}

/**
 * 从一次 `tool/call` 里取出被改动的文件（短路径），取不到返回 null。
 *
 * 宿主的真实形状（从会话日志核对过，不是照抄文档）：
 *   `{ turn, step, callId, name, arguments }`，`arguments` 是 **JSON 字符串**。
 *
 * 先用 `includes('file_path')` 挡一道再 parse：`pwsh` 是最高频的调用
 * （历史会话里 2358 次），它的 arguments 可能很大，没必要每个都 JSON.parse。
 */
export function fileFromToolCall(name, rawArguments) {
	if (!FILE_TOOLS.includes(name)) return null;
	if (typeof rawArguments !== 'string' || !rawArguments.includes('file_path')) return null;
	try {
		const args = JSON.parse(rawArguments);
		const path = args?.file_path;
		if (typeof path !== 'string') return null;
		const short = shortPath(path);
		return short || null;
	} catch {
		return null; // 参数不是合法 JSON —— 当没有素材，绝不让它影响状态折叠
	}
}

/** 每会话初值。必须是 plain JSON（投影会做 structuredClone）。 */
export function initState() {
	return {
		mood: 0,
		energy: ENERGY_BASE,
		turn: 0,
		streakOk: 0,
		streakFail: 0,
		lastKind: 'session-start',
		lastDelta: 0,
		// 本轮实况
		toolCalls: 0,
		files: [],
		failed: 0,
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
		case 'tool/call': {
			// 步数与动过的文件：这是「本轮实况」的全部原料，只记事实，不做判断。
			const file = fileFromToolCall(data?.name, data?.arguments);
			const files = file && !state.files.includes(file)
				? [...state.files, file].slice(-MAX_FILES)
				: state.files;
			return {
				...state,
				toolCalls: state.toolCalls + 1,
				files,
				energy: clamp(state.energy - ENERGY_PER_CALL, ENERGY_MIN, ENERGY_MAX),
			};
		}

		case 'tool/result': {
			if (toolResultFailed(data)) {
				const mood = pullMood(state.mood, MOOD_TARGET_FAIL, MOOD_PULL_FAIL);
				let next = {
					...state,
					mood,
					energy: clamp(state.energy - 3, ENERGY_MIN, ENERGY_MAX),
					streakFail: state.streakFail + 1,
					streakOk: 0,
					failed: state.failed + 1,
					lastKind: 'tool-fail',
					lastDelta: mood - state.mood,
				};
				if (next.streakFail >= BLOCKED_STREAK) {
					const sunk = pullMood(next.mood, -8, MOOD_PULL_FAIL);
					next = {
						...next,
						mood: sunk,
						energy: clamp(next.energy - 15, ENERGY_MIN, ENERGY_MAX),
						lastKind: 'blocked',
						lastDelta: sunk - state.mood,
					};
				}
				return next;
			}
			const mood = pullMood(state.mood, MOOD_TARGET_OK, MOOD_PULL_OK);
			return {
				...state,
				mood,
				streakOk: state.streakOk + 1,
				streakFail: 0,
				lastKind: 'tool-ok',
				lastDelta: mood - state.mood,
			};
		}

		case 'llm/retry':
		case 'llm/retry-started': {
			const mood = pullMood(state.mood, -3, MOOD_PULL_FAIL);
			return { ...state, mood, lastKind: 'llm-retry', lastDelta: mood - state.mood };
		}

		case 'turn/start':
			// 新一轮 = 新实况。上一轮动过哪些文件不该跟着走到这一轮，
			// 「上一次」由跨会话存储单独负责。
			return { ...state, toolCalls: 0, files: [], failed: 0 };

		case 'turn/end': {
			const kind = data?.reason?.kind ?? 'unknown';
			const delta = kind === 'completed' ? 3 : kind === 'error' ? -6 : 0;
			// 先加本轮增量，再向基线回归（见 MOOD_REVERSION 的说明）
			const reverted = clamp(Math.round((state.mood + delta) * MOOD_REVERSION), MOOD_MIN, MOOD_MAX);
			// 轮末恢复精力：向基线回一截，出错的那一轮少回一点（同样取整，理由见 pullMood）
			const rested = Math.round(state.energy + (ENERGY_BASE - state.energy) * ENERGY_RECOVER);
			return {
				...state,
				turn: state.turn + 1,
				energy: clamp(kind === 'error' ? rested - 5 : rested, ENERGY_MIN, ENERGY_MAX),
				mood: reverted,
				streakFail: 0,
				lastKind: `turn-${kind}`,
				lastDelta: reverted - state.mood,
			};
		}

		default:
			// ← 必须返回同一引用（官方自己的投影也是这么写的）
			return state;
	}
}

/** 情绪强度 0..3：由 mood 幅度与连续受阻共同决定。 */
export function intensityOf(state) {
	if (state.streakFail >= BLOCKED_STREAK) return 3;
	// 阈值与新的稳态对齐：连续成功落在 ±20 附近，连续失败落在 -35 附近。
	// 沿用旧的 40/18 会让强度常年停在 1，也就失去区分度了。
	const m = Math.abs(state.mood);
	if (m >= 30) return 3;
	if (m >= 12) return 2;
	if (m >= 5) return 1;
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
	// 累先于「还行」：一轮里连着调几十次工具，本来就该露出疲态
	if (state.energy <= 25) return '有点累';
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
