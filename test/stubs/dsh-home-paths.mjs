/**
 * `@deepseek-ai/dsh-home-paths` 的测试桩件：
 * 把插件状态写到临时目录，避免冒烟测试污染真实 $DSH_HOME。
 */

import os from 'node:os';
import path from 'node:path';

export function dshHomePath(...segments) {
	return path.join(os.tmpdir(), 'dsh-emotion-smoke-home', ...segments);
}

export default { dshHomePath };
