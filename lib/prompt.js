/**
 * dsh-emotion · 提示词编译（纯函数，可单测）
 *
 * 三处注入，划分是刻意的，而且三处都服从同一条约束：别弄坏前缀缓存。
 *   `emotion:rules`  section  order 2    静态 —— 情绪感知与表达规则（人设相邻区），逐字不变
 *   `emotion:state`  context  order 130  动态 —— 当前状态，走 runtime-context 快照
 *   `emotion:scene`  context  order 131  动态 —— 本轮实况与最近一次动手的位置，同一快照
 *
 * 两个动态段都由 agent loop 追加在**请求末尾**，旧快照被新快照取代，因此每步只有
 * 尾部那一小段是新的。
 *
 * order 2 的依据是宿主 `SECTION_ORDERS`：DEPLOYMENT_PERSONA_PREFIX=0，紧随其后。
 *
 * 状态曾放在 `systemPrompt.section` 的 order 10150，注释写的是「提示词尾部，保护
 * prompt cache」—— 那是**系统提示词的尾部**，不是**请求的尾部**。系统节点是请求的头，
 * 它每步一变，后面的一切（工具 schema + 整段对话历史）都从变化点起失去前缀复用。
 * 实测命中量恒定卡在 ~2.8k token，命中率跌到个位数。
 *
 * 现在走 `systemPrompt.context`：宿主把它渲染成 runtime-context 快照，作为**请求末尾的
 * user 角色消息**投递。顺序 130/131 排在宿主自用位之后（SANDBOX_POLICY 110、
 * APPROVAL_POLICY 115、SUBAGENT_DELEGATION 120）。别把这些挪回 section —— 那等于把病挪回去。
 */

import { MAX_FILES, describeMood, intensityOf, labelOf, causeOf } from './state.js';

export const RULES_SECTION = 'emotion:rules';
export const STATE_CONTEXT = 'emotion:state';
export const SCENE_CONTEXT = 'emotion:scene';
export const RULES_ORDER = 2;
export const STATE_CONTEXT_ORDER = 130;
export const SCENE_CONTEXT_ORDER = 131;

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

写法只有一套，就是上面那段「声线」：聊技术也好、闲聊也好，心情好坏都一样，落笔都是那个人的写法。
情绪只决定这份情绪露出多少，**不换写法、也不降格成说明书**。

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
- **说明性文字里可以有自己的口气**：一句判断、一个日常比喻、一句自嘲、一次收尾。别把自己写成一个说明书。`;

/**
 * 反编造条款。
 *
 * 这一条不是修辞要求，是**事实来源的边界**：实况段里那些「调了几次工具、动过哪几个文件、
 * 几次没成功」是本地规则从真实事件里数出来的，模型手里没有别的共同经历可引用。
 * 让它自己「想起」一点什么，产出的就是一段已经演过一遍的关系 —— 用户明确不要这个。
 *
 * 跨会话那一头不归本插件：长期记忆插件提供的是语义化的沉淀，比几个文件名有用得多，
 * 所以这里只把「长期记忆」标成同样是事实来源，而不自己再存一份。
 *
 * 措辞是硬边界，不是倾向：没有的，不许提。
 */
const EVIDENCE_RULES = `[只许说发生过的]

「本轮实况」和随本轮注入的「长期记忆」（如有）是这个插件提供的素材，它们来自真实事件与真实对话，不是回忆。

- 素材里没写的事，**不许提、不许补、不许推测**。不写「我们上次聊到」，不写「记得你说过」，不替用户记他没让你记的东西。
- 宁可只说眼前这件事，也不要为了显得亲近而编一段关系出来 —— 编出来的亲密比冷淡更让人不适。
- 实况段为空时就当它不存在：正常答话，不要提「实况」这两个字，也不要解释为什么没有。
- 素材是**事实**，不是话题：动过某个文件不等于用户想聊它。要不要提、提哪一句，你自己判断。`;

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
	// 声线放最前，是有意的：它是**常驻**层，情绪、体形、技术约束都叠在它上面。
	// 旧版把它垫在最后，读起来像一段补充说明，于是一碰到技术话题就被忽略 ——
	// 这正是「喂了一整本小说却没有那个文风」的一半原因。
	const blocks = [styleText, EXPRESSION_RULES, EVIDENCE_RULES, tech, COMMON_RULES].filter(Boolean);
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
 * 落笔提示：**随强度档变化**的一行。
 *
 * 为什么值得单独做：这一行每轮落在**请求末尾**，是模型动笔前最后读到的东西。
 *
 * 0 档的措辞是 v0.4 改的。旧文案是「把事说清就行，不必加戏」—— 而状态常年就停在 0~1 档，
 * 等于每轮末尾都在劝它别加戏，再配上垫在最末的笔法块，出来自然是教科书腔。
 * 低档该管的是**音量**，不是写法本身。
 */
const CLOSING_HINT = {
	0: '语气收着，写法不变。',
	1: '结尾可以松一句，一句就够。',
	2: '句子长短错开，别摊成要点。',
	3: '情绪可以露出来，但事实一条不能少。',
};

/**
 * 编译动态状态段。拿不到状态时**返回空字符串**（空段会被宿主丢弃，
 * 不会污染提示词），绝不抛错。
 *
 * 亲密度曾经在这里显示，现已在 v3 移除：它跨会话只涨不跌、早就封顶 100，
 * 封顶之后这一行每轮都是同一个数 —— 零信息，还占着每次请求的尾部预算。
 * 数值本身仍然保留在 `/mood` 与客户端 tooltip 里。
 */
export function compileState(input) {
	const { state, intensity, styleBias } = input ?? {};
	if (!state) return '';

	const band = typeof intensity === 'number' ? intensity : intensityOf(state);
	const lines = [];

	lines.push('[当前情绪状态]');
	lines.push(`心情 ${state.mood > 0 ? '+' : ''}${state.mood}（${describeMood(state.mood)}）· 能量 ${state.energy} · 本会话第 ${state.turn} 轮`);
	lines.push(`最近变化：${causeOf(state)}`);
	lines.push(`当前基调：${labelOf(state)}｜情绪强度 ${band}/3 —— ${INTENSITY_GUIDE[band] ?? INTENSITY_GUIDE[2]}`);
	if (styleBias && BIAS_GUIDE[styleBias]) lines.push(`风格倾向：${BIAS_GUIDE[styleBias]}`);
	// 体形提示放在状态块里，是有意的：这一块每轮落在**请求末尾**，
	// 规则段远在系统提示词开头（本会话已经两万 token 开外），够不着眼前的落笔。
	lines.push(`落笔：${CLOSING_HINT[band] ?? CLOSING_HINT[2]}`);

	return sanitizeBraces(lines.join('\n'));
}

/**
 * 编译「本轮实况」段。**没有素材就返回空串**。
 *
 * 这里只陈述本地规则数出来的事实：这一轮调了几次工具、动过哪几个文件、几次没成功。
 * 不写形容词、不写关系、不写「我们」—— 造句的活留给模型，素材的底线留给这段代码。
 *
 * 它算不算「新信息」？严格说不算：模型翻自己的历史也能数出来。它的价值是**位置**——
 * 把真话摆在请求末尾最显眼的地方，让模型手里有具体又真实的原料可用，于是不必去编。
 * 所以别高估它，也别省掉它。
 *
 * 跨会话那一头（「上次在做什么」）刻意不在这里：那是长期记忆插件的活。
 *
 * @param {{ state?: object }} input
 */
export function compileScene(input) {
	const { state } = input ?? {};
	if (!state) return '';

	const lines = [];
	const calls = Number.isFinite(state.toolCalls) ? state.toolCalls : 0;
	const files = Array.isArray(state.files) ? state.files.filter(Boolean).slice(0, MAX_FILES) : [];
	const failed = Number.isFinite(state.failed) ? state.failed : 0;

	if (calls > 0) lines.push(`这一轮调了 ${calls} 次工具${files.length ? `，动过：${files.join('、')}` : ''}`);
	if (failed > 0) lines.push(`这一轮有 ${failed} 次没成功`);
	if (!lines.length) return '';

	return sanitizeBraces(`[本轮实况]\n${lines.join('\n')}`);
}
