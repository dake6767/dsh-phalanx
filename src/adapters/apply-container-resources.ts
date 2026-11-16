import type { InstanceResourceLimits } from '../domain/instance-resources.js'
import { instanceResourceArguments } from '../dsh/member-resource-limits.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { OwnedCommunityContainers } from './community-containers.js'
import type { CgroupInstanceResources } from './instance-resource-cgroup.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

export async function applyContainerResources(
  runtime: string,
  containers: Pick<OwnedCommunityContainers, 'assertCarrier'>,
  cgroups: Pick<CgroupInstanceResources, 'read'>,
  instance: CommunityUserInstance,
  limits: InstanceResourceLimits,
) {
  await containers.assertCarrier(instance)
  try {
    await execFileText(runtime, ['update', ...instanceResourceArguments(limits), instance.containerName!], {
      env: containerClientEnvironment(),
      timeout: 30_000,
    })
  } catch {
    /* A still-readable carrier can fall back to a confirmed restart. */
  }
  await containers.assertCarrier(instance)
  const observed = await cgroups.read(instance.processId)
  Object.assign(instance, { resourceLimits: observed })
  return observed
}
