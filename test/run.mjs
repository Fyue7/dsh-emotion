/**
 * dsh-emotion 单元测试 —— 不依赖宿主，纯 Node 即可跑：
 *   node test/run.mjs
 *
 * 覆盖设计文档 §10 要求的几条硬纪律：
 *   · 无关事件返回同一引用（破了注册表的 Object.is 闸门就失效）
 *   · apply / view 是同步的（异步会被 viewSchema.parse 拒绝）
 *   · 边界 clamp
 *   · tool/result 的失败判据（宿主真实类型挂在 message 上）
 *   · 连续失败 ≥3 的派生路径
 *   · {{…}} 消毒（否则用户文本能让提示词组装抛错）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = await import('../lib/state.js');
const prompt = await import('../lib/prompt.js');

let passed = 0;
let failed = 0;

function test(label, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  ✗ ${label}\n      ${error.message}`);
	}
}

console.log('\nlib/state.js');

test('无关事件返回同一引用', () => {
	const s = state.initState();
	for (const type of ['user/message', 'assistant/message', 'request/header', 'step/start', 'nope/nope']) {
		assert.strictEqual(state.applyEvent(s, { type, data: {} }), s, `${type} 造出了新对象`);
	}
});

test('applyEvent 是同步的', () => {
	const s = state.initState();
	const next = state.applyEvent(s, { type: 'tool/result', data: { message: { isError: true } } });
	assert.ok(!(next instanceof Promise), 'applyEvent 返回了 Promise');
});

test('tool/result 失败判据挂在 message.isError 上', () => {
	const s = state.initState();
	const viaMessage = state.applyEvent(s, { type: 'tool/result', data: { message: { isError: true } } });
	assert.ok(viaMessage.mood < 0, 'message.isError=true 未被识别为失败');

	const viaError = state.applyEvent(s, { type: 'tool/result', data: { error: { name: 'x', code: 'y' } } });
	assert.ok(viaError.mood < 0, 'data.error 未被识别为失败');

	// 反面：写在 data.isError（设计文档初稿的写法）不应被误判
	const wrongShape = state.applyEvent(s, { type: 'tool/result', data: { isError: true } });
	assert.ok(wrongShape.mood > 0, '把 data.isError 当成了失败判据 —— 说明判据写错了位置');
});

test('连续失败 ≥3 触发「卡住了」', () => {
	let s = state.initState();
	for (let i = 0; i < 3; i += 1) {
		s = state.applyEvent(s, { type: 'tool/result', data: { message: { isError: true } } });
	}
	assert.strictEqual(s.streakFail, 3);
	assert.strictEqual(s.lastKind, 'blocked');
	assert.strictEqual(state.intensityOf(s), 3);
});

test('clamp 不越界', () => {
	let s = state.initState();
	for (let i = 0; i < 200; i += 1) {
		s = state.applyEvent(s, { type: 'tool/result', data: { message: { isError: true } } });
	}
	assert.ok(s.mood >= state.MOOD_MIN, `mood 越界: ${s.mood}`);
	assert.ok(s.energy >= state.ENERGY_MIN, `energy 越界: ${s.energy}`);

	let up = state.initState();
	for (let i = 0; i < 500; i += 1) up = state.applyEvent(up, { type: 'tool/result', data: {} });
	assert.ok(up.mood <= state.MOOD_MAX, `mood 上界越界: ${up.mood}`);
});

test('turn/end 按 reason 分支', () => {
	const s = state.initState();
	const done = state.applyEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	assert.strictEqual(done.turn, 1);
	assert.ok(done.mood > 0, 'completed 未给正向变化');

	const err = state.applyEvent(s, { type: 'turn/end', data: { reason: { kind: 'error' } } });
	assert.ok(err.mood < 0, 'error 未给负向变化');
});

test('labelOf / describeMood 有界且不抛错', () => {
	for (const mood of [-100, -50, -10, 0, 10, 50, 100]) {
		const s = { ...state.initState(), mood };
		assert.equal(typeof state.labelOf(s), 'string');
		assert.equal(typeof state.describeMood(s.mood), 'string');
	}
});

test('长期顺利不会把心情顶到上限（回归基线）', () => {
	// 回归测试：v1 没有任何衰减，连续 50 次工具成功就把 mood 顶到 +100 并锁死，
	// 状态段此后每轮输出同一句话 —— 用户完全感觉不到情绪在变。
	let s = state.initState();
	for (let turn = 0; turn < 40; turn += 1) {
		for (let i = 0; i < 10; i += 1) s = state.applyEvent(s, { type: 'tool/result', data: {} });
		s = state.applyEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	}
	assert.ok(s.mood < 60, `心情被顶到 ${s.mood} —— 回归机制没生效`);
	assert.ok(s.mood > 0, `长期顺利却是负心情：${s.mood}`);
});

test('长期失败不会把心情钉死在下限', () => {
	let s = state.initState();
	for (let turn = 0; turn < 40; turn += 1) {
		s = state.applyEvent(s, { type: 'tool/result', data: { message: { isError: true } } });
		s = state.applyEvent(s, { type: 'turn/end', data: { reason: { kind: 'error' } } });
	}
	assert.ok(s.mood > -60, `心情被钉死在 ${s.mood}`);
});

test('轮次收尾后连续失败计数归零', () => {
	let s = state.initState();
	s = state.applyEvent(s, { type: 'tool/result', data: { message: { isError: true } } });
	s = state.applyEvent(s, { type: 'tool/result', data: { message: { isError: true } } });
	assert.equal(s.streakFail, 2);
	s = state.applyEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	assert.equal(s.streakFail, 0, '新一轮应从零开始计连续失败');
});

test('单轮里调几十次工具也不会把心情顶到饱和', () => {
	// 回归测试（v3 的主刀）：v2 是「每次成功 +2、只在轮末砍半」，
	// 一轮里 50 次工具调用就把 mood 顶到 +96（实测值），此后的状态段每轮都是同一行字。
	// 事件级指数回归必须把一轮之内的稳态压在 ±25 附近。
	let s = state.initState();
	for (let i = 0; i < 50; i += 1) {
		s = state.applyEvent(s, { type: 'tool/call', data: { name: 'pwsh', arguments: '{}' } });
		s = state.applyEvent(s, { type: 'tool/result', data: {} });
	}
	assert.ok(s.mood <= 40, `一轮之内心情爬到 ${s.mood} —— 事件级回归没生效`);
	assert.ok(s.mood > 0, `一轮顺利却是负心情：${s.mood}`);
});

test('tool/call 记下改动过的文件（去重、只留末两段、上限 3 个）', () => {
	let s = state.initState();
	const call = (name, file) => {
		s = state.applyEvent(s, { type: 'tool/call', data: { name, arguments: JSON.stringify({ file_path: file }) } });
	};
	call('edit', 'E:\\agent\\projects\\dsh-emotion\\lib\\state.js');
	assert.deepEqual(s.files, ['lib/state.js'], '没取到文件的末两段');

	call('edit', 'E:\\agent\\projects\\dsh-emotion\\lib\\state.js');
	assert.deepEqual(s.files, ['lib/state.js'], '同一个文件被记了两次');

	call('write', '/a/b/c/d/prompt.js');
	call('edit', 'x/y/z/third.js');
	call('edit', 'x/y/z/fourth.js');
	assert.equal(s.files.length, 3, '没按上限截断');
	assert.deepEqual(s.files, ['d/prompt.js', 'z/third.js', 'z/fourth.js']);
	assert.equal(s.toolCalls, 5);
});

test('只有 edit/write 算「动过文件」', () => {
	// read/grep 走过一百个文件也不代表这一轮在做这件事 —— 素材宁可少，不可脏。
	let s = state.initState();
	s = state.applyEvent(s, { type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"a/b/c.js"}' } });
	s = state.applyEvent(s, { type: 'tool/call', data: { name: 'pwsh', arguments: '{"command":"dir"}' } });
	s = state.applyEvent(s, { type: 'tool/call', data: { name: 'edit', arguments: '这不是 JSON' } });
	assert.deepEqual(s.files, [], '无关工具或坏参数污染了素材');
	assert.equal(s.toolCalls, 3);
});

test('新一轮清空实况，但保留心情与轮次', () => {
	let s = state.initState();
	s = state.applyEvent(s, { type: 'tool/call', data: { name: 'edit', arguments: '{"file_path":"a/b.js"}' } });
	s = state.applyEvent(s, { type: 'tool/result', data: { message: { isError: true } } });
	assert.equal(s.files.length, 1);
	assert.equal(s.failed, 1);

	s = state.applyEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	const mood = s.mood;
	s = state.applyEvent(s, { type: 'turn/start', data: {} });
	assert.deepEqual(s.files, []);
	assert.equal(s.toolCalls, 0);
	assert.equal(s.failed, 0);
	assert.equal(s.turn, 1, '轮次不该被实况清理带走');
	assert.equal(s.mood, mood, '清实况不该动心情');
});

console.log('\nlib/prompt.js');

test('compileState 拿不到状态时返回空串（不抛错）', () => {
	assert.strictEqual(prompt.compileState({}), '');
	assert.strictEqual(prompt.compileState({ state: null }), '');
	assert.strictEqual(prompt.compileState(undefined), '');
});

test('sanitizeBraces 消灭插值组', () => {
	assert.ok(!prompt.hasInterpolationGroup(prompt.sanitizeBraces('危险 {{foo}} 结尾')));
	assert.ok(!prompt.hasInterpolationGroup(prompt.sanitizeBraces('{{a}}{{b}}')));
	assert.ok(prompt.hasInterpolationGroup('未处理的 {{foo}}'), '探针本身失效');
});

test('规则段不含插值组（含外部风格文本）', () => {
	const text = prompt.compileRules({ styleText: '用户自定义 {{note}} 内容' });
	assert.ok(!prompt.hasInterpolationGroup(text), '规则段里残留了 {{…}}');
});

test('技术内容的两种约束可切换', () => {
	// loose：技术内容允许带口气，「不做文学化改写」那条被禁掉。
	// 注意 compileRules 自身默认 plain（保守），插件配置默认才是 loose。
	const loose = prompt.compileRules({ plainTechnical: false });
	assert.match(loose, /技术内容不再要求朴素/);
	// 关键：放开的是讲法，不是信息量
	assert.match(loose, /信息不省/);
	assert.match(loose, /技术完整性压过/);
	assert.ok(!loose.includes('留白'), 'loose 模式又混进了「留白」—— 那会砍信息量');
	assert.ok(!loose.includes('只约束技术产物本身'), '默认模式仍带着朴素约束');

	// plain：回到历史行为，边界限定在技术产物上。
	// 回归测试：v0.1.1 的措辞是「技术内容不做情绪修饰」，
	// 实际被理解成「只要这轮在谈技术就整段肃静」，吃掉了绝大部分表达空间。
	const plain = prompt.compileRules({ plainTechnical: true });
	assert.match(plain, /只约束技术产物本身/);
	assert.match(plain, /不受此限/);

	// 两条不可协商的约束在两种模式下都得在。
	assert.match(loose, /12 个汉字/);
	assert.match(plain, /12 个汉字/);
});

test('状态段随强度档变化', () => {
	const s = { ...state.initState(), mood: 30, energy: 80, turn: 4 };
	const low = prompt.compileState({ state: s, intensity: 1 });
	const high = prompt.compileState({ state: s, intensity: 3 });
	assert.notEqual(low, high);
	assert.match(high, /强度 3\/3/);
});

test('状态段含成因与轮次', () => {
	const s = { ...state.initState(), turn: 7, lastKind: 'blocked', streakFail: 3 };
	const text = prompt.compileState({ state: s });
	assert.match(text, /第 7 轮/);
	assert.match(text, /连续受阻/);
	// v3：亲密度从状态段移除 —— 跨会话只涨不跌、封顶 100 之后这一行每轮都是同一个数，
	// 零信息还占着请求尾部的预算。数值本身仍在 /mood 与客户端 tooltip 里。
	assert.ok(!text.includes('亲密度'), '亲密度又回到了状态段');
});

test('落笔行随强度档变化，不是写死的常量', () => {
	// 这一行每轮落在请求末尾，是模型动笔前最后读到的东西。写死等于白占位置。
	const s = { ...state.initState(), mood: 30 };
	const hint = (text) => text.split('\n').find((line) => line.startsWith('落笔：'));
	const low = prompt.compileState({ state: s, intensity: 0 });
	const high = prompt.compileState({ state: s, intensity: 3 });
	assert.ok(hint(low) && hint(high), '状态段里没有落笔行');
	assert.notEqual(hint(low), hint(high), '落笔行没有随强度变化');
});

test('状态里的数值是整数（小数不该漏进提示词）', () => {
	// 指数回归会自然产出小数；取整必须发生在**每一步**，否则注入的是
	// 「心情 +22.97800615166195」这种又难看又白烧 token 的东西。
	let s = state.initState();
	for (let i = 0; i < 17; i += 1) s = state.applyEvent(s, { type: 'tool/result', data: {} });
	assert.ok(Number.isInteger(s.mood), `心情漏出了小数：${s.mood}`);

	s = state.applyEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	assert.ok(Number.isInteger(s.mood), `轮末心情漏出小数：${s.mood}`);
	assert.ok(Number.isInteger(s.energy), `轮末能量漏出小数：${s.energy}`);

	const text = prompt.compileState({ state: s });
	assert.ok(!/\d\.\d/.test(text), `状态段里出现了小数：${text}`);
});

test('规则段带着「不许编关系」的硬边界', () => {
	const text = prompt.compileRules({});
	assert.match(text, /只许说发生过的/);
	assert.match(text, /不许提、不许补、不许推测/);
});

test('实况段：没有素材就是空串', () => {
	// 反编造的兜底就在这里：素材为空 → 段为空 → 模型手里没有可编的原料。
	assert.strictEqual(prompt.compileScene({}), '');
	assert.strictEqual(prompt.compileScene({ state: null }), '');
	assert.strictEqual(prompt.compileScene({ state: state.initState() }), '');
});

test('实况段只陈述素材里的事实', () => {
	const text = prompt.compileScene({
		state: { ...state.initState(), toolCalls: 12, files: ['lib/state.js', 'lib/prompt.js'], failed: 2 },
	});
	assert.match(text, /这一轮调了 12 次工具/);
	assert.match(text, /lib\/state\.js、lib\/prompt\.js/);
	assert.match(text, /这一轮有 2 次没成功/);
	// 素材里没有的东西，这段代码没有资格说 —— 关系措辞只该由模型基于素材自己判断
	assert.ok(!/陪|一直|记得|想念|我们/.test(text), `实况段里出现了关系措辞：${text}`);
});

test('实况段最多列 3 个文件', () => {
	const text = prompt.compileScene({
		state: { ...state.initState(), toolCalls: 9, files: ['a/1.js', 'b/2.js', 'c/3.js', 'd/4.js'] },
	});
	assert.ok(text.includes('a/1.js') && text.includes('c/3.js'));
	assert.ok(!text.includes('d/4.js'), '文件列表没按上限截断');
});

test('实况段无素材时不出现「实况」二字以外的空壳', () => {
	// 有工具调用但没动过文件：只说调用次数，不编文件
	const text = prompt.compileScene({ state: { ...state.initState(), toolCalls: 4 } });
	assert.match(text, /这一轮调了 4 次工具/);
	assert.ok(!text.includes('动过'), '没动过文件却说动过');
});

console.log('\nlib/style.js');

const style = await import('../lib/style.js');

test('档案缺失时 renderStyle 返回空串', () => {
	assert.strictEqual(style.renderStyle(null), '');
	assert.strictEqual(style.renderStyle(undefined), '');
});

test('助手回复样例优先，且保留段落结构', () => {
	// 场景错位的 few-shot 等于没给样例：小说段落教的是「小说怎么抒情」，
	// 而不是「助手怎么带着语气把技术事情说清」。所以助手样例必须优先。
	const profile = {
		assistantSamples: ['第一句。\n\n第二段。'],
		samples: ['这是小说段落，不该被同时渲染'],
	};
	const text = style.renderStyle(profile, 'balanced');
	assert.match(text, /目标样例/);
	assert.ok(text.includes('第一句。\n第二段。'), '段落结构被压平了 —— 断行本身就是笔法');
	assert.ok(!text.includes('这是小说段落'), '有了助手样例就不该再渲染小说段落');
});

test('没有助手样例时回退到 samples', () => {
	const profile = { samples: ['甲乙丙'] };
	assert.match(style.renderStyle(profile, 'balanced'), /甲乙丙/);
});

test('renderStyle 按 styleBias 控制样例条数', () => {
	const profile = {
		rhythm: { avgSentenceLen: 28.2, medianSentenceLen: 23, shortSentenceRatio: 0.233, longSentenceRatio: 0.251 },
		punctuation: { dash: 'rare', ellipsis: 'occasional' },
		styleDirectives: ['不直说情绪', '收尾留一句轻的'],
		samples: ['甲甲甲', '乙乙乙', '丙丙丙'],
	};
	const restrained = style.renderStyle(profile, 'restrained');
	const outgoing = style.renderStyle(profile, 'outgoing');
	assert.match(restrained, /平均句长约 28\.2 字/);
	assert.match(outgoing, /丙丙丙/);
	assert.ok(!restrained.includes('丙丙丙'), 'restrained 档注入了过多样例');
	assert.ok(outgoing.length > restrained.length);
});

console.log('\nlib/store.js');

const store = await import('../lib/store.js');

test('亲密度读写与 clamp', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-emotion-test-'));
	const s = store.createClosenessStore(dir);
	assert.strictEqual(s.get(), 0);
	s.bump(1.5);
	assert.strictEqual(s.get(), 1.5);
	for (let i = 0; i < 200; i += 1) s.bump(10);
	assert.strictEqual(s.get(), store.CLOSENESS_MAX);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('global.json 损坏时回落而不抛错', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-emotion-bad-'));
	fs.writeFileSync(path.join(dir, 'global.json'), '{ 这不是 JSON', 'utf8');
	const s = store.createClosenessStore(dir);
	assert.strictEqual(s.get(), 0);
	fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
