/**
 * dsh-emotion · 同步拷贝工具
 *
 * 为什么需要它：profile 通过 `file:E:/agent/projects/dsh-emotion` 引用本插件，
 * 但 pnpm 落地的是**真拷贝**而不是符号链接：
 *   ~/.dsh/profiles/desktop/node_modules/dsh-emotion/
 * 所以直接改项目里的源码，运行中的进程读到的仍是旧代码 —— 会对着旧代码调半天。
 *
 * 用法：
 *   node tools/sync.mjs            # 同步
 *   node tools/sync.mjs --check    # 只比对，不写（CI 用）
 *
 * 同步后必须**完全重启** Harness 进程才生效（模块缓存不会自己刷新）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 需要镜像到安装位置的内容（相对路径）。 */
export const ENTRIES = ['package.json', 'lib', 'client', 'style'];

/** 默认安装位置：desktop profile 的 node_modules 下。 */
export function defaultTarget(home = os.homedir()) {
	return path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-emotion');
}

function walk(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

/** 逐文件比对，返回不一致的相对路径。 */
export function diff(source, target) {
	const stale = [];
	for (const entry of ENTRIES) {
		const from = path.join(source, entry);
		if (!fs.existsSync(from)) continue;
		const stat = fs.statSync(from);
		const files = stat.isDirectory() ? walk(from) : [from];
		for (const file of files) {
			const rel = path.relative(source, file);
			const to = path.join(target, rel);
			if (!fs.existsSync(to)) {
				stale.push(rel);
				continue;
			}
			if (!fs.readFileSync(file).equals(fs.readFileSync(to))) stale.push(rel);
		}
	}
	return stale;
}

function copy(source, target, rel) {
	const to = path.join(target, rel);
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.copyFileSync(path.join(source, rel), to);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	const target = process.env.DSH_EMOTION_TARGET ?? defaultTarget();
	const checkOnly = process.argv.includes('--check');

	if (!fs.existsSync(target)) {
		console.error(`安装位置不存在：${target}\n（profile 没装本插件？先 pnpm add，或设 DSH_EMOTION_TARGET）`);
		process.exit(2);
	}

	const stale = diff(SOURCE, target);
	if (checkOnly) {
		if (stale.length === 0) {
			console.log('已同步：无差异');
			process.exit(0);
		}
		console.error(`未同步（${stale.length} 个文件）：\n  ${stale.join('\n  ')}`);
		process.exit(1);
	}

	for (const rel of stale) copy(SOURCE, target, rel);
	console.log(stale.length === 0 ? '已同步：无差异' : `已拷贝 ${stale.length} 个文件：\n  ${stale.join('\n  ')}`);
	console.log(`目标：${target}`);
	console.log('下一步：完全退出并重启 Harness —— 模块缓存不会自己刷新。');
}
