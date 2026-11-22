import Docker from 'dockerode';
import type { ContainerSummary, ServiceName } from '@selfhost/shared';
import { AgentError } from './errors';

export interface DockerClient {
  listServiceContainers(service: ServiceName): Promise<ContainerSummary[]>;
}

// Each service is a compose project named selfhost-<service>.
export const projectName = (service: ServiceName) => `selfhost-${service}`;

function parseHealth(status: string): ContainerSummary['health'] {
  if (status.includes('(unhealthy)')) return 'unhealthy';
  if (status.includes('(healthy)')) return 'healthy';
  if (status.includes('(health: starting)')) return 'starting';
  return null;
}

export function createDockerClient(socketPath = '/var/run/docker.sock'): DockerClient {
  const docker = new Docker({ socketPath });
  return {
    async listServiceContainers(service) {
      try {
        const containers = await docker.listContainers({
          all: true,
          filters: { label: [`com.docker.compose.project=${projectName(service)}`] },
        });
        return await Promise.all(
          containers.map(async (container) => ({
            name: (container.Names[0] ?? container.Id).replace(/^\//, ''),
            state: container.State,
            health: parseHealth(container.Status),
            startedAt: await docker
              .getContainer(container.Id)
              .inspect()
              .then(
                (info) => (info.State.Running ? info.State.StartedAt : null),
                () => null,
              ),
          })),
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES') {
          throw new AgentError('docker_unavailable', 'Docker is not running or cannot be reached.');
        }
        throw error;
      }
    },
  };
}

export function createFixtureDockerClient(): DockerClient {
  return {
    async listServiceContainers(service) {
      return [
        {
          name: projectName(service),
          state: 'running',
          health: 'healthy',
          startedAt: new Date().toISOString(),
        },
      ];
    },
  };
}
