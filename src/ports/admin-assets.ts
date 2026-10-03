export interface AdminAsset {
  readonly body: Buffer
  readonly contentType: string
  readonly immutable: boolean
}

/** Read a built admin asset without exposing filesystem access to HTTP routes. */
export interface AdminAssetSource {
  read(name: string | undefined): Promise<AdminAsset | undefined>
}
