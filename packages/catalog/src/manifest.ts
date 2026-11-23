import { z } from 'zod';
import { libraryFolder, serviceName } from '@selfhost/shared';

const port = z.number().int().min(1024).max(65535);
const containerName = z.string().regex(/^[a-z][a-z0-9-]*$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const serviceManifest = z
  .object({
    name: serviceName,
    displayName: z.string().min(1),
    description: z.string().min(1),
    // What the owner sees in "Update available". Bump it together with the image pins.
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
    releaseNotesUrl: z.string().regex(/^https:\/\/[A-Za-z0-9./_-]+$/),
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
            // Pins the exact image, so a re-tagged or tampered tag is never pulled.
            digest: digest.optional(),
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
    // How the pre-update snapshot treats this service. Folders listed in skipDirs are left out of the
    // copy (databases are saved with pg_dump instead, caches are rebuilt on demand).
    snapshot: z
      .object({
        skipDirs: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
        database: z
          .object({
            container: containerName,
            user: z.string().regex(/^[a-z][a-z0-9_]*$/),
            name: z.string().regex(/^[a-z][a-z0-9_]*$/),
            // Folder under the config folder that holds the Postgres files.
            dataDir: z.string().regex(/^[a-z][a-z0-9-]*$/),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ skipDirs: [] }),
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
    gpu: z.object({ intel: z.boolean() }).strict(),
    firstLoginTips: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ServiceManifest = z.infer<typeof serviceManifest>;
