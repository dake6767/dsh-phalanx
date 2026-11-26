/** Node's ESM exports resolution matches the DSH plugin metadata resource seam without evaluating the plugin. */
export const pluginDisplayResolutionFlag = '--experimental-import-meta-resolve'

/** Shared by the isolated preparation worker and the read-only frozen preparation reader. */
export const pluginDisplayMetadataReader = String.raw`
import { constants as metadataFlags } from 'node:fs';
import { open as openMetadataFile, readdir as listMetadataDirectory, realpath as metadataRealpath } from 'node:fs/promises';
import { dirname as metadataDirname, extname, isAbsolute, join as metadataJoin, relative as metadataRelative, resolve as metadataResolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function readPluginDisplayMetadata(profile, packageName, version, checkedManifest) {
  const limit = 256 * 1024;
  const contained = (root, path) => {
    const local = metadataRelative(root, path);
    return Boolean(local) && local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local);
  };
  const modules = await metadataRealpath(metadataJoin(profile, 'node_modules'));
  if (!contained(profile, modules)) throw new Error('Plugin modules are outside the preparation');
  const root = await metadataRealpath(metadataJoin(modules, packageName));
  if (!contained(modules, root)) throw new Error('Plugin package is outside the preparation');
  const insidePackage = async path => {
    const file = await metadataRealpath(path);
    if (!contained(root, file)) throw new Error('Plugin metadata is outside the package');
    return file;
  };
  const read = async (file, maximum = limit) => {
    const handle = await openMetadataFile(file, metadataFlags.O_RDONLY | metadataFlags.O_NOFOLLOW | metadataFlags.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maximum) throw new Error('Plugin metadata is not a bounded regular file');
      const bytes = await handle.readFile();
      if (bytes.length > maximum) throw new Error('Plugin metadata exceeds the size limit');
      return bytes;
    } finally {
      await handle.close();
    }
  };
  // Frozen preparations have already passed manifest validation. The display limit applies to the resources.
  const manifest = checkedManifest ?? JSON.parse((await read(await insidePackage(metadataJoin(root, 'package.json')), Infinity)).toString('utf8'));
  if (manifest.name !== packageName || manifest.version !== version) throw new Error('Plugin metadata identity changed');
  const parent = pathToFileURL(metadataJoin(profile, 'package.json')).href;
  const exported = resource => fileURLToPath(import.meta.resolve(packageName + '/' + resource, parent));
  const title = {}, description = {};
  try {
    const english = exported('locale/en.json');
    const directory = metadataDirname(english);
    const localeRoot = metadataDirname(await insidePackage(english));
    if (localeRoot !== await metadataRealpath(directory)) throw new Error('Plugin locales are outside the English locale directory');
    for (const filename of (await listMetadataDirectory(localeRoot)).sort()) {
      if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*\.json$/u.test(filename)) continue;
      try {
        const path = exported('locale/' + filename);
        if (metadataDirname(path) !== directory) continue;
        const file = await insidePackage(path);
        if (metadataDirname(file) !== localeRoot) continue;
        const { meta } = JSON.parse((await read(file)).toString('utf8'));
        const language = filename.slice(0, -5).toLowerCase();
        if (typeof meta?.title === 'string' && meta.title.trim() && !Object.hasOwn(title, language)) title[language] = meta.title.slice(0, 256);
        if (typeof meta?.description === 'string' && meta.description.trim() && !Object.hasOwn(description, language)) description[language] = meta.description.slice(0, 4096);
      } catch {
        // A bad dictionary leaves the other locales and fields available.
      }
    }
  } catch {
    // No readable English locale export.
  }
  let icon;
  try {
    const declared = manifest.icon;
    if (declared !== undefined && (typeof declared !== 'string' || !declared.trim() || isAbsolute(declared) || win32.isAbsolute(declared) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(declared)))
      throw new Error('Plugin icon must be a package-relative file');
    const path = declared === undefined ? exported('icon') : metadataResolve(root, declared);
    const mime = new Map([['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]).get(extname(path).toLowerCase());
    if (mime) {
      const bytes = await read(await insidePackage(path));
      if (bytes.length) icon = 'data:' + mime + ';base64,' + bytes.toString('base64');
    }
  } catch {
    // A missing or invalid icon leaves the text unchanged.
  }
  return { ...(Object.keys(title).length ? { title } : {}), ...(Object.keys(description).length ? { description } : {}), ...(icon ? { icon } : {}) };
}
`
