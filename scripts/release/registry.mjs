export async function registryDigest(name, tag) {
  const tokenResponse = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${name.slice(8)}:pull,push`, {
    headers: { authorization: `Basic ${Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString('base64')}` },
  })
  if (!tokenResponse.ok) throw new Error(`Registry token request failed: HTTP ${tokenResponse.status}`)
  const token = (await tokenResponse.json()).token
  const response = await fetch(`https://ghcr.io/v2/${name.slice(8)}/manifests/${tag}`, { headers: {
    authorization: `Bearer ${token}`, accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
  } })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Registry manifest request failed: HTTP ${response.status}`)
  const digest = response.headers.get('docker-content-digest')
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error('Missing registry digest')
  return digest
}
