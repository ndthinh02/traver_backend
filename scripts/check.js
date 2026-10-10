import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
import { spawnSync } from 'node:child_process';
function check(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) check(p); else if (p.endsWith('.js')) { const r = spawnSync(process.execPath, ['--check', p], { stdio: 'inherit' }); if (r.status) process.exit(r.status); } } }
check('src'); check('scripts'); console.info('JavaScript syntax checks passed');
