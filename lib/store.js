/**
 * dsh-emotion · 跨会话「亲密度」持久化
 *
 * 为什么要单独存：会话投影是**逐会话**的（`init` 按会话构造、`stateOf` 按会话读取），
 * 装不下跨会话累积量 —— 塞进去会导致每个新会话都从 0 开始，功能直接失效。
 *
 * 纪律：
 *   - 只存 `{closeness, updatedAt}` 两个字段；
 *   - 原子写（临时文件 + rename），节流 ≥2 秒，避免每轮写盘；
 *   - 读失败/损坏一律回落默认值，**不得因此让插件加载失败**。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CLOSENESS_MIN = 0;
export const CLOSENESS_MAX = 100;
const WRITE_THROTTLE_MS = 2000;

export function createClosenessStore(dir) {
	const file = join(dir, 'global.json');
	let value = 0;

	try {
		if (existsSync(file)) {
			const raw = JSON.parse(readFileSync(file, 'utf8'));
			if (typeof raw?.closeness === 'number' && Number.isFinite(raw.closeness)) {
				value = Math.min(CLOSENESS_MAX, Math.max(CLOSENESS_MIN, raw.closeness));
			}
		}
	} catch {
		value = 0; // 损坏即回落，绝不让插件起不来
	}

	let lastWrite = 0;

	function persist() {
		const now = Date.now();
		if (now - lastWrite < WRITE_THROTTLE_MS) return;
		lastWrite = now;
		try {
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, JSON.stringify({ closeness: value, updatedAt: now }, null, 2), 'utf8');
			renameSync(tmp, file);
		} catch {
			// 写失败不影响运行
		}
	}

	return {
		file,
		get: () => value,
		bump(delta) {
			value = Math.min(CLOSENESS_MAX, Math.max(CLOSENESS_MIN, value + delta));
			persist();
			return value;
		},
		reset() {
			value = 0;
			lastWrite = 0;
			persist();
			return value;
		},
	};
}
