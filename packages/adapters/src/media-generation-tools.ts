import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { ExternalEffect, PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { mediaPromptSchema, validateGeneratedMedia } from "./media-generation-provider.js";

const JOB_KIND = "media_generation_job";
const savedJob = z.object({
  provider: z.string(),
  jobId: z.string().optional(),
  artifactId: z.string().optional(),
});
export async function generateMediaFromTool(options: {
  name: "generate_image" | "generate_video";
  args: Record<string, unknown>;
  executionId: string;
  provider: MediaGenerationProvider;
  prisma: PrismaClient;
  context: AdapterContext;
  run: { id: string; threadId: string; botId: string; userId: string; spaceId: string };
  attach: (
    output: GeneratedMedia,
    name: string,
  ) => Promise<{ artifactId: string; block: MessageBlock }>;
  publish: (block: MessageBlock, jobId: string, artifactId: string) => Promise<unknown>;
}) {
  const { provider, prisma, context, run, args } = options;
  const video = options.name === "generate_video";
  if (!(video ? provider.capabilities.video : provider.capabilities.images))
    return { error: "Media generation is unavailable." };
  try {
    if (
      args.jobId !== undefined &&
      (!video ||
        typeof args.jobId !== "string" ||
        !args.jobId ||
        args.jobId.length > 200 ||
        args.prompt !== undefined)
    ) {
      return { error: "Use a prompt to submit or jobId alone to poll a video." };
    }
    let reservation: ExternalEffect | null = null;
    let polling = false;
    if (video && typeof args.jobId === "string") {
      reservation = await prisma.externalEffect.findFirst({
        where: {
          id: args.jobId,
          kind: JOB_KIND,
          spaceId: run.spaceId,
          run: { userId: run.userId, botId: run.botId, threadId: run.threadId },
        },
      });
      if (!reservation) return { error: "Video job is unavailable." };
      const saved = savedJob.safeParse(reservation.result);
      if (!saved.success || saved.data.provider !== provider.id)
        return {
          error:
            "Video job provider changed or submission is uncertain. Do not resubmit automatically.",
        };
      if (saved.data.artifactId) return { status: "completed", artifactId: saved.data.artifactId };
      if (reservation.status === "media_failed") return { status: "failed" };
      if (!saved.data.jobId)
        return { error: "Submission is uncertain. Do not resubmit automatically." };
      const claim = await prisma.externalEffect.updateMany({
        where: {
          id: reservation.id,
          OR: [
            { status: "media_pending" },
            { status: "media_polling", updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
          ],
        },
        data: { status: "media_polling" },
      });
      if (!claim.count)
        return {
          error:
            "Video job is already being checked or needs recovery. Do not resubmit automatically.",
        };
      polling = true;
    } else {
      const prior = await prisma.externalEffect.findFirst({
        where: {
          runId: run.id,
          kind: JOB_KIND,
          request: { path: ["executionId"], equals: options.executionId },
        },
      });
      if (prior) {
        const saved = savedJob.safeParse(prior.result);
        return saved.success && saved.data.artifactId
          ? { status: "completed", artifactId: saved.data.artifactId }
          : {
              jobId: prior.id,
              error:
                "Submission already attempted. Poll a video job; do not resubmit automatically.",
            };
      }
      const input = mediaPromptSchema.safeParse(args);
      if (!input.success) return { error: "A prompt of 1–4000 characters is required." };
      // A unique slot makes the per-run cap durable even across concurrent calls/restarts.
      for (let slot = 0; slot < 2; slot++) {
        try {
          reservation = await prisma.externalEffect.create({
            data: {
              spaceId: run.spaceId,
              runId: run.id,
              kind: JOB_KIND,
              idempotencyKey: `media:${run.id}:${slot}`,
              status: "media_submitting",
              request: {
                tool: options.name,
                prompt: input.data.prompt,
                executionId: options.executionId,
              },
              result: { provider: provider.id },
            },
          });
          break;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "P2002"))
            throw error;
        }
      }
      if (!reservation)
        return { error: "Media generation limit reached (two submissions per run)." };
    }
    const saved = savedJob.parse(reservation.result);
    let output: MediaVideoJob | { status: "completed"; output: GeneratedMedia };
    try {
      output = video
        ? saved.jobId
          ? await provider.pollVideo(saved.jobId, context)
          : await provider.generateVideo(mediaPromptSchema.parse(args), context)
        : {
            status: "completed" as const,
            output: await provider.generateImage(mediaPromptSchema.parse(args), context),
          };
    } catch (error) {
      if (polling)
        await prisma.externalEffect.updateMany({
          where: { id: reservation.id, status: { not: "media_completed" } },
          data: { status: "media_pending" },
        });
      throw error;
    }
    if (video && "id" in output) {
      await prisma.externalEffect.updateMany({
        where: { id: reservation.id, status: { not: "media_completed" } },
        data: {
          status:
            output.status === "failed"
              ? "media_failed"
              : output.status === "completed"
                ? "media_polling"
                : "media_pending",
          result: { provider: provider.id, jobId: output.id },
        },
      });
    }
    if (output.status !== "completed")
      return {
        jobId: reservation.id,
        status: output.status,
        ...("progress" in output ? { progress: output.progress } : {}),
      };
    validateGeneratedMedia(output.output, video ? "video/mp4" : "image/png");
    context.signal.throwIfAborted();
    const attached = await options.attach(
      output.output,
      `generated-${reservation.id}.${video ? "mp4" : "png"}`,
    );
    await options.publish(attached.block, reservation.id, attached.artifactId);
    return { status: "completed", artifactId: attached.artifactId };
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error:
        error instanceof MediaGenerationError
          ? error.message
          : "Media generation failed. Submission may have been accepted; do not retry automatically.",
    };
  }
}
