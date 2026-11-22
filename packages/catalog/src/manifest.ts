import { z } from 'zod';
import { libraryFolder, serviceName } from '@selfhost/shared';

const port = z.number().int().min(1024).max(65535);
const containerName = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const serviceManifest = z
  .object({
    name: serviceName,
    displayName: z.string().min(1),
    description: z.string().min(1),
    ports: z.object({ lan: port, remote: port }).strict(),
    images: z
      .array(
        z
          .object({
            container: containerName,
            repository: z.string().regex(/^[a-z0-9._/-]+$/),
            // Pinned versions only: "latest" and other floating tags are rejected.
            tag: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
              .refine((tag) => tag !== 'latest', 'Image tags must be pinned'),
          })
          .strict(),
      )
      .min(1),
    libraryFolders: z
      .array(z.object({ folder: libraryFolder, access: z.enum(['ro', 'rw']) }).strict())
      .min(1),
    // Folders under /opt/selfhost/config/<name> that containers write to. The agent creates them
    // owned by the selfhost user, otherwise Docker creates them as root and the container cannot write.
    configDirs: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
    health: z.object({ path: z.string().regex(/^\/[A-Za-z0-9._/-]*$/) }).strict(),
    gpu: z.object({ intel: z.boolean() }).strict(),
    firstLoginTips: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ServiceManifest = z.infer<typeof serviceManifest>;
