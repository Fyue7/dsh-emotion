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

test('规则段包含技术内容不文学化的硬约束', () => {
	const text = prompt.compileRules({});
	assert.match(text, /技术内容不做情绪修饰/);
	assert.match(text, /12 个汉字/);
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
	const text = prompt.compileState({ state: s, closeness: 34 });
	assert.match(text, /第 7 轮/);
	assert.match(text, /连续受阻/);
	assert.match(text, /亲密度 34/);
});

console.log('\nlib/style.js');

const style = await import('../lib/style.js');

test('档案缺失时 renderStyle 返回空串', () => {
	assert.strictEqual(style.renderStyle(null), '');
	assert.strictEqual(style.renderStyle(undefined), '');
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
