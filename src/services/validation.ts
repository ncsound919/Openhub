import { z } from 'zod';

/**
 * One runtime contract layer for OpenHub's HTTP request bodies.
 *
 * The routes used to destructure `req.body` and hand-check each field with
 * `if (!x)`; a missing field then surfaced as an unhelpful 400 or, worse,
 * as `undefined` flowing into a SQL insert. zod keeps the shape, the limits
 * and the error message in one place per route.
 */

export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  const message = result.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ` : '') + issue.message)
    .join('; ');
  return { ok: false, error: message || 'Invalid request body' };
}

const safeName = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore')
  .refine((value) => value !== '.' && value !== '..', 'invalid name');

export const SshKeySchema = z.object({
  title: z.string().min(1, 'Title required'),
  key: z.string().min(1, 'Key required'),
});

export const GitHubImportSchema = z.object({
  owner: safeName,
  repo: safeName,
});

export const PushSyncSchema = z.object({
  repoName: z.string().min(1, 'repoName required'),
  filePath: z.string().min(1, 'filePath required'),
  content: z.string().optional(),
  message: z.string().optional(),
});

export const GenerateTestsSchema = z.object({
  file: z.string().min(1, 'File path required'),
});

export const AvatarSchema = z.object({
  dataUrl: z
    .string()
    .regex(/^data:image\/(png|jpe?g|webp|gif);base64,/, 'A base64 data URL of a PNG/JPEG/WebP/GIF image is required'),
});

export const EmailSchema = z.object({
  email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'A valid email is required'),
});

export const PasswordSchema = z.object({
  current: z.string().optional(),
  next: z.string().min(8, 'New password must be at least 8 characters'),
});

export const NotificationsSchema = z.record(z.string(), z.boolean());

export const RepoCreateSchema = z.object({
  name: z.string().trim().pipe(safeName.max(100, 'Repository name too long (max 100)')),
  description: z.string().optional(),
  isPrivate: z.boolean().optional(),
});

export const RepoImportLocalSchema = z.object({
  path: z.string().min(1, 'A local folder path is required'),
  name: z.string().optional(),
});

export const RepoContentsSchema = z.object({
  path: z.string().min(1, 'filePath required'),
  content: z.string(),
  message: z.string().optional(),
});

export const GitHubPatConnectSchema = z.object({
  token: z.string().min(1, 'GitHub Personal Access Token is required'),
});

export const GitHubIssueSchema = z.object({
  title: z.string().min(1, 'Issue title is required'),
  body: z.string().optional(),
});

export const GitHubDispatchSchema = z.object({
  ref: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

export const ScanSchema = z.object({
  content: z.string(),
  fileName: z.string().optional(),
});

export const AuditLogSchema = z.object({
  action: z.string().min(1, 'action required'),
  details: z.string().optional(),
  repoId: z.string().optional(),
});

export const RegistryCreateSchema = z.object({
  name: z.string().min(1, 'name required'),
  type: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  version: z.string().optional(),
  config: z.unknown().optional(),
});

export const RegistryPatchSchema = z.object({
  status: z.string().optional(),
  config: z.unknown().optional(),
});

export const WebhookCreateSchema = z.object({
  url: z.string().url('URL required'),
  secret: z.string().optional(),
  events: z.array(z.string()).optional(),
});

export const OllamaChatSchema = z.object({
  prompt: z.string().min(1, 'prompt is required'),
});
