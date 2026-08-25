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

type CreativeBriefSchemaData = z.infer<typeof creativeBriefSchema>;
export type CreativeBrief = Omit<Readonly<CreativeBriefSchemaData>, 'constraints'> & {
  readonly constraints?: ReadonlyArray<string>;
};

export type StoryboardDraftShotPayload = Readonly<z.infer<typeof storyboardDraftShotPayloadSchema>>;

type StoryboardDraftPayloadSchemaData = z.infer<typeof storyboardDraftPayloadSchema>;
export type StoryboardDraftPayload = Omit<Readonly<StoryboardDraftPayloadSchemaData>, 'shots'> & {
  readonly shots: ReadonlyArray<StoryboardDraftShotPayload>;
};

export interface StoryboardDraftShot extends StoryboardDraftShotPayload {
  readonly id: string;
}

export type AiCostEstimate =
  | { readonly kind: 'known'; readonly amount: number; readonly currency: string; readonly note?: string }
  | { readonly kind: 'unknown'; readonly note: string };

export interface StoryboardModelDescriptor {
  readonly id: string;
  readonly name: string;
  readonly cost: AiCostEstimate;
}

export interface StoryboardGenerateRequest {
  readonly model: string;
  readonly brief: CreativeBrief;
  readonly signal: AbortSignal;
}

export interface AiStoryboardCapability {
  readonly capability: typeof AI_STORYBOARD_GENERATE_CAPABILITY;
  readonly models: ReadonlyArray<StoryboardModelDescriptor>;
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
  readonly model: string;
  readonly prompt: string;
  readonly referenceImage?: { readonly mime: string; readonly data: string };
  readonly signal: AbortSignal;
}

export interface AiReferenceImageResult {
  readonly mime: string;
  readonly data: string;
}

export interface AiReferenceImageCapability {
  readonly capability: typeof AI_REFERENCE_IMAGE_GENERATE_CAPABILITY;
  readonly models: ReadonlyArray<StoryboardModelDescriptor>;
  generate(request: AiReferenceImageRequest): Promise<AiReferenceImageResult>;
}

export interface StoryboardDraft {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly generatedAt: string;
  readonly title: string;
  readonly summary: string;
  readonly brief: CreativeBrief;
  readonly cost: AiCostEstimate;
  readonly shots: ReadonlyArray<StoryboardDraftShot>;
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
  readonly code: AiProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly costKnown: boolean;
  readonly retryAfterMs?: number;
}

export class AiProviderRequestError extends Error implements AiProviderErrorData {
  readonly code: AiProviderErrorCode;
  readonly retryable: boolean;
  readonly costKnown: boolean;
  readonly retryAfterMs?: number;

  constructor(data: AiProviderErrorData) {
    const normalized = normalizeAiProviderErrorData(data, false, true);
    super(normalized.message);
    this.name = 'AiProviderRequestError';
    this.code = normalized.code;
    this.retryable = normalized.retryable;
    this.costKnown = normalized.costKnown;
    this.retryAfterMs = normalized.retryAfterMs;
  }
}

export type GenerationTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface GenerationTask {
  readonly id: string;
  readonly capability: typeof AI_STORYBOARD_GENERATE_CAPABILITY;
  readonly providerId: string;
  readonly model: string;
  readonly brief: CreativeBrief;
  readonly cost: AiCostEstimate;
  readonly status: GenerationTaskStatus;
  readonly submittedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly draft?: StoryboardDraft;
  readonly error?: AiProviderErrorData;
}

export interface StoryboardProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly models: ReadonlyArray<StoryboardModelDescriptor>;
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

const GENERIC_PROVIDER_ERROR_MESSAGE = 'The AI provider request failed.';

function publicAiProviderErrorMessage(code: unknown): string {
  switch (code) {
    case 'invalid_request': return 'The AI request is invalid.';
    case 'provider_unavailable': return 'The AI provider is unavailable.';
    case 'model_unsupported': return 'The AI model is not supported.';
    case 'timeout': return 'The AI provider request timed out.';
    case 'rate_limited': return 'The AI provider rate limit was reached.';
    case 'schema_invalid': return 'The AI provider returned an invalid response.';
    case 'cancelled': return 'Generation cancelled.';
    default: return GENERIC_PROVIDER_ERROR_MESSAGE;
  }
}

export function redactAiDiagnosticText(_message: string): string {
  return GENERIC_PROVIDER_ERROR_MESSAGE;
}

const KNOWN_AI_PROVIDER_ERROR_CODES = new Set<AiProviderErrorCode>([
  'invalid_request',
  'provider_unavailable',
  'model_unsupported',
  'timeout',
  'rate_limited',
  'schema_invalid',
  'cancelled',
  'provider_error',
]);

function readOwnDataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAiProviderErrorData(
  error: unknown,
  fallbackCostKnown: boolean,
  allowCancelled: boolean,
): AiProviderErrorData {
  try {
    const candidateCode = readOwnDataProperty(error, 'code');
    const normalizedCode = typeof candidateCode === 'string' && KNOWN_AI_PROVIDER_ERROR_CODES.has(candidateCode as AiProviderErrorCode)
      ? (candidateCode as AiProviderErrorCode)
      : 'provider_error';
    const code = !allowCancelled && normalizedCode === 'cancelled' ? 'provider_error' : normalizedCode;
    const retryable = readOwnDataProperty(error, 'retryable');
    const costKnown = readOwnDataProperty(error, 'costKnown');
    const retryAfterMs = readOwnDataProperty(error, 'retryAfterMs');
    return {
      code,
      message: publicAiProviderErrorMessage(code),
      retryable: typeof retryable === 'boolean' ? retryable : code === 'timeout' || code === 'rate_limited',
      costKnown: typeof costKnown === 'boolean' ? costKnown : fallbackCostKnown === true,
      ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? { retryAfterMs }
        : {}),
    };
  } catch {
    return {
      code: 'provider_error',
      message: GENERIC_PROVIDER_ERROR_MESSAGE,
      retryable: false,
      costKnown: fallbackCostKnown === true,
    };
  }
}

export function normalizeAiProviderError(error: unknown, fallbackCostKnown = false): AiProviderErrorData {
  return normalizeAiProviderErrorData(error, fallbackCostKnown, false);
}
