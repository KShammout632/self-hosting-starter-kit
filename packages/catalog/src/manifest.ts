import { z } from 'zod';
import { libraryFolder, serviceName } from '@selfhost/shared';

const port = z.number().int().min(1024).max(65535);
const containerName = z.string().regex(/^[a-z][a-z0-9-]*$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

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
    // Random values the agent generates once and keeps in <config>/.env (mode 0600). Each alias
    // gets the same value, for containers that expect the password under a different name.
    secrets: z
      .array(z.object({ name: envName, aliases: z.array(envName).default([]) }).strict())
      .default([]),
    // Values the owner needs once, such as the Nextcloud admin login: a fixed value, or the name
    // of one of the secrets above.
    credentials: z
      .array(
        z
          .object({
            label: z.string().min(1),
            value: z.string().min(1).optional(),
            secret: envName.optional(),
          })
          .strict()
          .refine((entry) => (entry.value === undefined) !== (entry.secret === undefined), {
            message: 'A credential has either a value or a secret',
          }),
      )
      .default([]),
    // For images whose process runs as a fixed user (Nextcloud runs as www-data, uid 33). The agent
    // gives that user ownership of the read-write library folders.
    libraryOwnerUid: z.number().int().min(1).max(65535).optional(),
    health: z
      .object({
        path: z.string().regex(/^\/[A-Za-z0-9._/-]*$/),
        // The response body must contain this text, for services that answer 200 before they are ready.
        expect: z
          .string()
          .regex(/^[\x20-\x7E]{1,64}$/)
          .optional(),
      })
      .strict(),
    gpu: z
      .object({
        intel: z.boolean(),
        // Added to the image tag when the GPU is used, for example -openvino.
        imageSuffix: z
          .string()
          .regex(/^-[a-z0-9]+$/)
          .optional(),
      })
      .strict(),
    firstLoginTips: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ServiceManifest = z.infer<typeof serviceManifest>;
