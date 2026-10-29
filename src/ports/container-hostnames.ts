export interface ContainerOwner {
  readonly username: string
  readonly spaceId: string
}
/** A retired container may be removed without adopting its hostname into a new space. */
export interface ContainerHostnames {
  get(owner: ContainerOwner): Promise<string>
  remember(owner: ContainerOwner, hostname: string): Promise<string | undefined>
}
