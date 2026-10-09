import { registryDependenciesAllowed } from '../domain/plugin-library.js'

/** Archive inspection is executed only in a network-disabled container, without extraction. */
export const pluginArchiveInspection = `
import { execFileSync } from 'node:child_process';
const registryDependenciesAllowed = ${registryDependenciesAllowed.toString()};
try {
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', '/upload.tgz', 'package/package.json'], { encoding: 'utf8', maxBuffer: 1048576, timeout: 30000 }));
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || typeof manifest.dsh?.bundle?.patch !== 'string' || !manifest.dsh.bundle.patch.startsWith('./'))
    console.log(JSON.stringify({ ok: false, code: 'plugin-package-invalid' }));
  else if (!registryDependenciesAllowed(manifest)) console.log(JSON.stringify({ ok: false, code: 'plugin-dependency-invalid' }));
  else console.log(JSON.stringify({ ok: true, packageName: manifest.name, version: manifest.version }));
} catch { console.log(JSON.stringify({ ok: false, code: 'plugin-package-invalid' })); }
`
