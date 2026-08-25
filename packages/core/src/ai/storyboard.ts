import { z } from 'zod';

export const AI_STORYBOARD_GENERATE_CAPABILITY = 'ai.storyboard.generate' as const;
export const AI_REFERENCE_IMAGE_GENERATE_CAPABILITY = 'ai.image.reference.generate' as const;

export const STORYBOARD_SHOT_SIZES = [
  'extreme-wide',
  'wide',
  'medium',
  'close-up',
  'extreme-close-up',
] as const;

export const STORYBOARD_CAMERA_MOVEMENTS = [
  'static',
  'pan',
  'tilt',
  'dolly-in',
  'dolly-out',
  'tracking',
  'orbit',
  'handheld',
] as const;

export type StoryboardShotSize = (typeof STORYBOARD_SHOT_SIZES)[number];
export type StoryboardCameraMovement = (typeof STORYBOARD_CAMERA_MOVEMENTS)[number];

const creativeBriefSchema = z
  .object({
    concept: z.string().trim().min(10).max(4_000),
    targetDurationSeconds: z.number().finite().min(1).max(3_600),
    shotCount: z.number().int().min(1).max(24),
    visualStyle: z.string().trim().min(1).max(500).optional(),
    audience: z.string().trim().min(1).max(300).optional(),
    constraints: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  })
  .strict()
  .superRefine((brief, context) => {
    if (brief.targetDurationSeconds * 10 < brief.shotCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Target duration must allow at least 0.1 seconds per shot.',
        path: ['targetDurationSeconds'],
      });
    }
    if (brief.targetDurationSeconds > brief.shotCount * 600) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Target duration cannot exceed 600 seconds per shot.',
        path: ['targetDurationSeconds'],
      });
    }
  });

const storyboardDraftShotPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    shotSize: z.enum(STORYBOARD_SHOT_SIZES),
    movement: z.enum(STORYBOARD_CAMERA_MOVEMENTS),
    durationSeconds: z.number().finite().min(0.1).max(600),
    prompt: z.string().trim().min(1).max(4_000),
  })
  .strict();

const storyboardDraftPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2_000),
    shots: z.array(storyboardDraftShotPayloadSchema).min(1).max(24),
  })
  .strict();

export type CreativeBrief = z.infer<typeof creativeBriefSchema>;
export type StoryboardDraftShotPayload = z.infer<typeof storyboardDraftShotPayloadSchema>;
export type StoryboardDraftPayload = z.infer<typeof storyboardDraftPayloadSchema>;

export interface StoryboardDraftShot extends StoryboardDraftShotPayload {
  id: string;
}

export type AiCostEstimate =
  | { kind: 'known'; amount: number; currency: string; note?: string }
  | { kind: 'unknown'; note: string };

export interface StoryboardModelDescriptor {
  id: string;
  name: string;
  cost: AiCostEstimate;
}

export interface StoryboardGenerateRequest {
  model: string;
  brief: CreativeBrief;
  signal: AbortSignal;
}

export interface AiStoryboardCapability {
  capability: typeof AI_STORYBOARD_GENERATE_CAPABILITY;
  models: StoryboardModelDescriptor[];
  generate(request: StoryboardGenerateRequest): Promise<unknown>;
}

const aiCostEstimateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('known'),
      amount: z.number().finite().nonnegative(),
      currency: z.string().trim().min(1).max(16),
      note: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unknown'),
      note: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

const storyboardModelDescriptorSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(200),
    cost: aiCostEstimateSchema,
  })
  .strict();

const aiStoryboardCapabilitySchema = z
  .object({
    capability: z.literal(AI_STORYBOARD_GENERATE_CAPABILITY),
    models: z.array(storyboardModelDescriptorSchema).min(1).max(100),
    generate: z.custom<AiStoryboardCapability['generate']>(
      (value) => typeof value === 'function',
      'Storyboard capability generate must be callable.',
    ),
  })
  .strict()
  .superRefine((capability, context) => {
    const modelIds = new Set<string>();
    capability.models.forEach((model, index) => {
      if (modelIds.has(model.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Storyboard model id must be unique: ${model.id}`,
          path: ['models', index, 'id'],
        });
      }
      modelIds.add(model.id);
    });
  });

export interface AiReferenceImageRequest {
  model: string;
  prompt: string;
  referenceImage?: { mime: string; data: string };
  signal: AbortSignal;
}

export interface AiReferenceImageResult {
  mime: string;
  data: string;
}

export interface AiReferenceImageCapability {
  capability: typeof AI_REFERENCE_IMAGE_GENERATE_CAPABILITY;
  models: StoryboardModelDescriptor[];
  generate(request: AiReferenceImageRequest): Promise<AiReferenceImageResult>;
}

export interface StoryboardDraft {
  id: string;
  providerId: string;
  model: string;
  generatedAt: string;
  title: string;
  summary: string;
  brief: CreativeBrief;
  cost: AiCostEstimate;
  shots: StoryboardDraftShot[];
}

export type AiProviderErrorCode =
  | 'invalid_request'
  | 'provider_unavailable'
  | 'model_unsupported'
  | 'timeout'
  | 'rate_limited'
  | 'schema_invalid'
  | 'cancelled'
  | 'provider_error';

export interface AiProviderErrorData {
  code: AiProviderErrorCode;
  message: string;
  retryable: boolean;
  costKnown: boolean;
  retryAfterMs?: number;
}

export class AiProviderRequestError extends Error implements AiProviderErrorData {
  readonly code: AiProviderErrorCode;
  readonly retryable: boolean;
  readonly costKnown: boolean;
  readonly retryAfterMs?: number;

  constructor(data: AiProviderErrorData) {
    super(redactAiDiagnosticText(data.message));
    this.name = 'AiProviderRequestError';
    this.code = data.code;
    this.retryable = data.retryable;
    this.costKnown = data.costKnown;
    this.retryAfterMs = data.retryAfterMs;
  }
}

export type GenerationTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface GenerationTask {
  id: string;
  capability: typeof AI_STORYBOARD_GENERATE_CAPABILITY;
  providerId: string;
  model: string;
  brief: CreativeBrief;
  cost: AiCostEstimate;
  status: GenerationTaskStatus;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  draft?: StoryboardDraft;
  error?: AiProviderErrorData;
}

export interface StoryboardProviderInfo {
  id: string;
  name: string;
  models: StoryboardModelDescriptor[];
}

export function parseCreativeBrief(value: unknown): CreativeBrief {
  return creativeBriefSchema.parse(value);
}

export function parseStoryboardDraftPayload(value: unknown): StoryboardDraftPayload {
  return storyboardDraftPayloadSchema.parse(value);
}

export function parseAiStoryboardCapability(value: unknown): AiStoryboardCapability {
  return aiStoryboardCapabilitySchema.parse(value);
}

export function redactAiDiagnosticText(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]{8,}/gi, 'Basic [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /((?:["']?)(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|client[-_ ]?secret|secret)(?:["']?)\s*[:=]\s*)(["'])[^\r\n]*?\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(
      /((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|client[-_ ]?secret|secret)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    );
}

export function normalizeAiProviderError(error: unknown, fallbackCostKnown = false): AiProviderErrorData {
  if (error instanceof AiProviderRequestError) {
    return {
      code: error.code,
      message: redactAiDiagnosticText(error.message),
      retryable: error.retryable,
      costKnown: error.costKnown,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'cancelled', message: 'Generation cancelled.', retryable: false, costKnown: false };
  }
  const candidate = error as Partial<AiProviderErrorData> | null;
  const knownCodes: AiProviderErrorCode[] = [
    'invalid_request',
    'provider_unavailable',
    'model_unsupported',
    'timeout',
    'rate_limited',
    'schema_invalid',
    'cancelled',
    'provider_error',
  ];
  const code = candidate && typeof candidate.code === 'string' && knownCodes.includes(candidate.code as AiProviderErrorCode)
    ? (candidate.code as AiProviderErrorCode)
    : 'provider_error';
  const rawMessage = error instanceof Error ? error.message : 'The AI provider request failed.';
  return {
    code,
    message: redactAiDiagnosticText(rawMessage),
    retryable: typeof candidate?.retryable === 'boolean' ? candidate.retryable : code === 'timeout' || code === 'rate_limited',
    costKnown: typeof candidate?.costKnown === 'boolean' ? candidate.costKnown : fallbackCostKnown,
    ...(typeof candidate?.retryAfterMs === 'number' && Number.isFinite(candidate.retryAfterMs)
      ? { retryAfterMs: candidate.retryAfterMs }
      : {}),
  };
}
