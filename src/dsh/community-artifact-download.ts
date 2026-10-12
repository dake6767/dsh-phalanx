/** Narrow projection of the frozen DSH workspaceFiles and Session lookup APIs. */
export interface ArtifactFileScope {
  readonly sessionId: string
  readonly workspaceRoot: string
  readonly homeRoot?: string
}
interface ArtifactFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
}
export interface ArtifactDownloadFiles {
  scope(id: string): Promise<ArtifactFileScope | undefined>
  presented(id: string, seq: number, index: number, signal: AbortSignal): Promise<string | undefined>
  stat(scope: ArtifactFileScope, path: string, signal: AbortSignal): Promise<ArtifactFileStat>
  read(scope: ArtifactFileScope, path: string, offset: number, length: number, signal: AbortSignal): Promise<ArtifactFileStat & { readonly offset: number; readonly data: Uint8Array }>
}

/** Self-contained route policy serialized into the protected native platform plugin. */
export function artifactDownloadHandler(files: ArtifactDownloadFiles): (request: Request) => Promise<Response> {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  const failure = (status: number) => Response.json({ error: 'File unavailable. Refresh the file and try again.' }, { status, headers })
  const validPath = (path: string) => path.length > 0 && path.length <= 8192 && ![...path].some(character => character.charCodeAt(0) < 32 || character === '\\') && !path.split('/').includes('..')
  const contained = (root: string, path: string) => path.startsWith(root.replace(/\/+$/u, '') + '/')
  return async request => {
    try {
      if (request.method !== 'POST' && request.method !== 'GET') return failure(405)
      request.signal.throwIfAborted()
      const query = new URL(request.url).searchParams
      if ([...query.keys()].some(key => query.getAll(key).length !== 1 || !['sessionId', 'path', 'seq', 'index', 'version'].includes(key))) return failure(400)
      const id = query.get('sessionId')
      if (!id || id.length > 256) return failure(400)
      const scope = await files.scope(id)
      if (!scope) return failure(403)
      let path = query.get('path')
      if (path !== null && (query.has('seq') || query.has('index'))) return failure(400)
      if (path === null) {
        const seq = query.get('seq'), index = query.get('index')
        if (seq === null || index === null || !/^\d+$/u.test(seq) || !/^\d+$/u.test(index) || !Number.isSafeInteger(Number(seq)) || !Number.isSafeInteger(Number(index))) return failure(400)
        path = await files.presented(id, Number(seq), Number(index), request.signal) ?? null
      }
      if (path === null) return failure(404)
      if (!validPath(path)) return failure(400)
      const sourcePath = path
      const source = await files.stat(scope, sourcePath, request.signal)
      if (![scope.workspaceRoot, scope.homeRoot].some(root => root !== undefined && contained(root, source.absolutePath))) return failure(403)
      const size = source.bytes
      if (size === undefined || !Number.isSafeInteger(size) || size < 0) return failure(422)
      // Stat alone succeeds for mode-000 files; admit only an actual readable file.
      const probe = await files.read(scope, sourcePath, 0, 1, request.signal)
      if (probe.version !== source.version || probe.absolutePath !== source.absolutePath || probe.bytes !== size) return failure(409)
      const filename = source.absolutePath.slice(source.absolutePath.lastIndexOf('/') + 1)
      if (request.method === 'POST') return Response.json({ version: source.version, filename, bytes: size }, { headers })
      if (query.get('version') !== source.version) return failure(409)
      const current = (value: ArtifactFileStat) => value.version === source.version && value.bytes === size && value.absolutePath === source.absolutePath
      let offset = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            request.signal.throwIfAborted()
            const live = await files.scope(id)
            if (live?.workspaceRoot !== scope.workspaceRoot || live.homeRoot !== scope.homeRoot) throw new Error('File access changed')
            if (!current(await files.stat(live, sourcePath, request.signal))) throw new Error('File changed')
            if (offset === size) { controller.close(); return }
            const length = Math.min(256 * 1024, size - offset)
            const chunk = await files.read(live, sourcePath, offset, length, request.signal)
            if (!current(chunk) || chunk.offset !== offset || chunk.data.length !== length || !current(await files.stat(live, sourcePath, request.signal))) throw new Error('File changed while reading')
            offset += length
            controller.enqueue(chunk.data)
          } catch (error) { controller.error(error) }
        },
      }, { highWaterMark: 0 })
      return new Response(body, { headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(size),
        'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/gu, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())}` } })
    } catch { return failure(403) }
  }
}

/** Connection's fetch registry applies native authentication before this route. */
export const artifactDownloadPlugin = `
  try { ctx.inject(['connection','workspaceFiles','typert','sessionQuery'], scope => { try {
    const lifetime = new AbortController();
    scope.effect(() => () => lifetime.abort());
    const handler = (${artifactDownloadHandler.toString()})({
      scope: async id => { const value = await scope.typert.lookups.get('workspaceFileScope')?.resolve(id); return value ? {...value,homeRoot:process.env.HOME} : undefined; },
      presented: async (sessionId,seq,index,signal) => {
        const result = await scope.sessionQuery.readEvent({sessionId,seq,before:0,after:0},signal);
        const file = result.target.type === 'deliverables/presented' && result.target.data?.files?.[index];
        return file && typeof file.path === 'string' ? file.path : undefined;
      },
      stat: (context,path,signal) => scope.workspaceFiles.stat(context,path,signal),
      read: (context,path,offset,length,signal) => scope.workspaceFiles.readBytes(context,path,{range:{offset,length}},signal),
    });
    scope.connection.fetch.register({path:'/api/phalanx.download',methods:['GET','POST'],requestBody:'buffered',fetch:request => handler(new Request(request,{signal:AbortSignal.any([request.signal,lifetime.signal])}))});
    } catch { console.warn('Platform artifact downloads are unavailable'); }
  }); } catch { console.warn('Platform artifact downloads are unavailable'); }
`
