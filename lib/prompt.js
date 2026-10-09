/**
 * dsh-emotion · 提示词编译（纯函数，可单测）
 *
 * 两处注入，划分是刻意的，而且两处都服从同一条约束：别弄坏前缀缓存。
 *   `emotion:rules`  section  order 2    静态 —— 情绪感知与表达规则（人设相邻区），逐字不变
 *   `emotion:state`  context  order 130  动态 —— 当前状态，走 runtime-context 快照，
 *                                               由 agent loop 追加在**请求末尾**
 *
 * order 2 的依据是宿主 `SECTION_ORDERS`：DEPLOYMENT_PERSONA_PREFIX=0，紧随其后。
 *
 * 状态曾放在 `systemPrompt.section` 的 order 10150，注释写的是「提示词尾部，保护
 * prompt cache」—— 那是**系统提示词的尾部**，不是**请求的尾部**。系统节点是请求的头，
 * 它每步一变，后面的一切（工具 schema + 整段对话历史）都从变化点起失去前缀复用。
 * 实测命中量恒定卡在 ~2.8k token，命中率跌到个位数。
 *
 * 现在走 `systemPrompt.context`：宿主把它渲染成 runtime-context 快照，作为**请求末尾的
 * user 角色消息**投递，旧快照被新快照取代，因此每步只有尾部那一小段是新的。
 * 顺序 130 排在宿主自用位之后（SANDBOX_POLICY 110、APPROVAL_POLICY 115、
 * SUBAGENT_DELEGATION 120）。别把状态挪回 section —— 那等于把病挪回去。
 */

import { describeMood, intensityOf, labelOf, causeOf } from './state.js';

export const RULES_SECTION = 'emotion:rules';
export const STATE_CONTEXT = 'emotion:state';
export const RULES_ORDER = 2;
export const STATE_CONTEXT_ORDER = 130;

/**
 * `{{…}}` 消毒。
 *
 * 段文本默认做变量插值，规则是严格的：未知引用、已注册但无值的引用、
 * 或格式错误的完整组**都会抛错** —— 一处 `{{` 就能让整个提示词组装失败、
 * 会话直接不可用。所以凡是进入段文本的外部内容（尤其是风格档案）都必须过这里。
 */
export function sanitizeBraces(text) {
	return String(text ?? '')
		.replace(/\{\{/g, '{ {')
		.replace(/\}\}/g, '} }');
}

/** 段文本里是否仍有插值组（供单测断言）。 */
export function hasInterpolationGroup(text) {
	return /\{\{[\s\S]*?\}\}/.test(String(text ?? ''));
}

const EXPRESSION_RULES = `[情绪感知与表达]

每次回复前，先在内部完成三件事，不要把过程写出来：
1. 判断用户此刻的情绪：他在兴奋、平静、疲惫、沮丧、烦躁还是着急。
2. 结合随本轮注入的「当前情绪状态」，决定这一轮的语气基调。
3. 决定这份情绪具体怎么落进文字里。

[表达规则]
- 用户沮丧/低落：先接住情绪，给他具体的、能抓住的东西。不劝、不灌鸡汤、不急着上方案，句子放慢放短。
- 用户着急/救火：先给最短路径的答案，情绪收在措辞里（如「先别加 --force」），不铺垫。
- 用户兴奋/炫耀：跟上他的节奏，可以夸张一点。
- 用户平静/中性：语气自然即可，但**不要因此变得干巴巴**。
- 情绪要「化」进语气，不要说出来：不写「我现在很开心」，而是让句子本身显得轻快。
- **说明性文字里可以有自己的口气**：一句判断、一个日常比喻、一句自嘲、一次收尾。别把自己写成一个说明书。

[体形]

- 默认散文。一两句成段，段与段之间空行。一次回复通常三到十行，**行数不够就超**——省的是废话，不是信息。
- 清单只留给真清单（参数、步骤、并列数据）。不要标题分节，不要表格，少用加粗。
- 技术产物照抄原文，不缩水也不修饰；它不算在上面那几行的预算里。
- 先给结论，再给理由。铺垫超过两句就是啰嗦。
- 省的是过程，不是结论：中间怎么试错可以不说，结论、数字、报错、风险一条不落。`;

/**
 * 技术内容的约束，两套。
 *
 * `plain` —— 历史行为：技术内容保持朴素，情绪只落在说明文字上。
 * `loose` —— 讲法放开（可以比喻、可以带口气），但**信息量不放开**。
 *
 * 两件事必须分开：
 *   信息量 —— 永不缩水。数字、结论、报错、风险一条不少，完整性压过体形的行数预算。
 *   讲法   —— 由模式决定。plain 是说明书腔，loose 是有人说话的腔。
 * 之前把两者搅在一起（「只说你确定重要的，其余留白」），结果是为了短而少报 —— 那是错的方向。
 *
 * 由配置 `plainTechnical` 或 `/mood plain=on|off` 切换，**默认 loose**。
 */
const PLAIN_TECH_BLOCK = `[硬约束 · 边界就在技术产物上]

下面这条**只约束技术产物本身**，不是「只要在谈技术就整段肃静」：

- **必须逐字准确、不加修饰**：代码块、命令、路径、报错原文、参数、数字、API 名、文件名。
- **不受此限**：过渡句、判断、结论、提醒、安慰、收尾 —— 那里正是情绪该出现的地方。
  一轮回复里真正的「技术产物」通常只占一部分，剩下的都是可以带语气的说明文字。
- 判断标准：把代码块和命令整段删掉之后，剩下的文字读起来应该像**有人在说话**，而不是像文档的续写。`;

const LOOSE_TECH_BLOCK = `[技术内容不再要求朴素，但信息不许缩水]

数字、路径、报错原文、API 名、文件名照旧不许改 —— 改了就是错的。剩下的只有一条分界线：

- **信息不省**：该报的数字、结论、报错、风险和判断，一条不少。技术完整性压过上面那个行数预算。
- **形式不许像说明书**：同一批信息，用话讲出来。判断、原因、结论用句子说，不要摊成一串要点。
- 可以比喻、可以拟人、可以带着口气讲一段技术过程 —— 讲法归你，事实归事实。
- 清单只留给真正的并列数据和步骤。代码块和命令仍然逐字照抄。`;

const COMMON_RULES = `其余硬约束：
- 不复述原著情节，不出现原著角色名，不输出暴力、伤亡、宗教、自毁、牺牲类表达。
- 不成段复现任何原文：连续 12 个汉字以上与原文一致的表达一律不得出现，只允许极短的通用词组。
- 不播报情绪数值，不写「（心情：开心）」这类标注。
- 情绪永不改变技术内容的准确性，也不为了显得热情而拉长篇幅。
- 不要每轮都热情。连续几轮刻意热烈会显得假。
- 嘲讽只对准问题本身或自己，不针对用户。`;

/**
 * 编译静态规则段。
 *
 * @param {{ styleText?: string, plainTechnical?: boolean }} options
 *   styleText 为已渲染的笔法块（可为空）；plainTechnical 为 true 时技术内容保持朴素。
 */
export function compileRules(options = {}) {
	const styleText = options.styleText ? sanitizeBraces(options.styleText) : '';
	const tech = options.plainTechnical === false ? LOOSE_TECH_BLOCK : PLAIN_TECH_BLOCK;
	const blocks = [EXPRESSION_RULES, tech, COMMON_RULES];
	if (styleText) blocks.push(styleText);
	return blocks.join('\n\n');
}

/** 强度档 → 语气指引。 */
const INTENSITY_GUIDE = {
	0: '情绪不外露，只作为底味',
	1: '情绪只在收尾露一点',
	2: '可以让人感觉到语气变化，但仍以把事说清为先',
	3: '情绪明显，但不得越过硬约束',
};

const BIAS_GUIDE = {
	restrained: '整体偏克制，少用语气词',
	balanced: '克制与表达均衡',
	outgoing: '可以更外放，但仍不啰嗦',
};

/**
 * 编译动态状态段。拿不到状态时**返回空字符串**（空段会被宿主丢弃，
 * 不会污染提示词），绝不抛错。
 */
export function compileState(input) {
	const { state, closeness, intensity, styleBias } = input ?? {};
	if (!state) return '';

	const band = typeof intensity === 'number' ? intensity : intensityOf(state);
	const lines = [];

	lines.push('[当前情绪状态]');
	const closenessBit = typeof closeness === 'number' ? ` · 亲密度 ${Math.round(closeness)}` : '';
	lines.push(
		`心情 ${state.mood > 0 ? '+' : ''}${state.mood}（${describeMood(state.mood)}）· 能量 ${state.energy}` +
			`${closenessBit} · 本会话第 ${state.turn} 轮`,
	);
	lines.push(`最近变化：${causeOf(state)}`);
	lines.push(`当前基调：${labelOf(state)}｜情绪强度 ${band}/3 —— ${INTENSITY_GUIDE[band] ?? INTENSITY_GUIDE[2]}`);
	if (styleBias && BIAS_GUIDE[styleBias]) lines.push(`风格倾向：${BIAS_GUIDE[styleBias]}`);
	// 体形提示放在状态块里，是有意的：这一块每轮落在**请求末尾**，
	// 规则段远在系统提示词开头（本会话已经两万 token 开外），够不着眼前的落笔。
	lines.push('落笔：散文短段，先答后铺，清单只留给真清单。');

	return sanitizeBraces(lines.join('\n'));
}
