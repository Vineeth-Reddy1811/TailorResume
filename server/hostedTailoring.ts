import { promises as fs } from "fs";
import { createTailoringRun, UserFacingTailoringError, type TailoringExecutionOptions } from "./tailoringService";
import { decryptProviderCredential } from "./providerCredentials";
import { getSupabaseAdminClient } from "./supabaseAuth";
import type { TailoringRunResponse } from "../shared/api";
import { loadHostedSkillCatalog, persistHostedSkillCandidates } from "./skillCatalog";

const hostedOutputLimitBytes = 15 * 1024 * 1024;
const hostedOutputFolder = "resume-files";
let hostedQueuePumpRunning = false;
let hostedQueuePumpRequested = false;

interface ClaimedRun {
  id: string;
  user_id: string;
}

function publicFailure(error: unknown): string {
  if (error instanceof UserFacingTailoringError) return error.message;
  if (error instanceof Error && /^Claude (?:rate limited|tailoring request failed)/.test(error.message)) return error.message;
  if (error instanceof Error && /^OpenAI API (?:key was rejected|prepaid credits|rate limited|encountered|tailoring request failed|did not|returned)/.test(error.message)) return error.message;
  return "Resume processing could not be completed. Check the saved resume and AI provider connection, then retry.";
}

async function processRun(run: ClaimedRun): Promise<void> {
  const admin = getSupabaseAdminClient();
  let temporaryDirectory: string | undefined;
  let uploadedObjectKey: string | undefined;
  try {
    const runResult = await admin.from("tailoring_runs")
      .select("id, user_id, source_resume_id, job_description, provider, model, credential_source, expires_at, status")
      .eq("id", run.id)
      .eq("user_id", run.user_id)
      .maybeSingle();
    const runRow = runResult.data;
    if (runResult.error || !runRow || runRow.status !== "running") return;
    if ((runRow.provider !== "anthropic" && runRow.provider !== "openai") || typeof runRow.model !== "string" || !runRow.model || typeof runRow.job_description !== "string") {
      throw new UserFacingTailoringError("This run is missing a supported AI provider or model. Update AI provider settings and retry.");
    }
    const provider = runRow.provider;
    const credentialSource = runRow.credential_source === "platform" ? "platform" : "user";
    if (credentialSource === "platform" && provider !== "openai") {
      throw new UserFacingTailoringError("TailorResume AI access only supports OpenAI runs right now.");
    }
    const providerLabel = provider === "openai" ? "OpenAI API" : "Claude";

    const [resumeResult, profileResult] = await Promise.all([
      admin.from("resumes")
        .select("id, object_key, original_file_name")
        .eq("id", runRow.source_resume_id)
        .eq("user_id", run.user_id)
        .is("deleted_at", null)
        .maybeSingle(),
      admin.from("experience_profiles")
        .select("profile_data")
        .eq("user_id", run.user_id)
        .maybeSingle(),
    ]);
    if (resumeResult.error || !resumeResult.data) throw new UserFacingTailoringError("Your saved base resume is no longer available. Upload it again, then retry.");
    if (profileResult.error || !profileResult.data?.profile_data) throw new UserFacingTailoringError("Your resume profile is unavailable. Upload or replace your base resume, then retry.");

    let credential: string;
    if (credentialSource === "platform") {
      const platformApiKey = process.env.TAILORRESUME_PLATFORM_AI_API_KEY?.trim();
      const platformModel = process.env.TAILORRESUME_PLATFORM_AI_MODEL?.trim();
      if (!platformApiKey || !platformModel || platformModel !== runRow.model) {
        throw new UserFacingTailoringError("TailorResume AI access is temporarily unavailable. Please retry later.");
      }
      credential = platformApiKey;
    } else {
      const credentialResult = await admin.from("provider_connections")
        .select("credential_ciphertext, credential_iv, credential_auth_tag, key_version, selected_model")
        .eq("user_id", run.user_id)
        .eq("provider", provider)
        .maybeSingle();
      if (credentialResult.error || !credentialResult.data || credentialResult.data.selected_model !== runRow.model) {
        throw new UserFacingTailoringError(`The ${providerLabel} key or selected model changed before this run started. Retry with your current provider settings.`);
      }
      credential = decryptProviderCredential(run.user_id, provider, {
        ciphertext: credentialResult.data.credential_ciphertext,
        iv: credentialResult.data.credential_iv,
        authTag: credentialResult.data.credential_auth_tag,
        keyVersion: credentialResult.data.key_version,
      });
    }
    const download = await admin.storage.from(hostedOutputFolder).download(resumeResult.data.object_key);
    if (download.error || !download.data) throw new UserFacingTailoringError("Your saved base resume could not be opened. Replace it in the resume section and retry.");
    const resumeBytes = Buffer.from(await download.data.arrayBuffer());
    const profileData = profileResult.data.profile_data as Record<string, unknown>;
    let skillCatalog;
    try {
      skillCatalog = await loadHostedSkillCatalog(admin);
    } catch (error) {
      throw new UserFacingTailoringError(error instanceof Error ? error.message : "The shared skill catalog is unavailable. Apply the latest Supabase migration, then retry.");
    }
    const options: TailoringExecutionOptions = {
      experienceProfile: profileData,
      provider,
      providerApiKey: credential,
      model: runRow.model,
      skillCatalog,
    };
    const tailored = await createTailoringRun(resumeBytes, resumeResult.data.original_file_name, runRow.job_description, options);
    temporaryDirectory = tailored.directory;
    tailored.response.runId = run.id;
    tailored.response.downloads.resume = `/api/account/runs/${run.id}/resume`;

    const outputBytes = await fs.readFile(tailored.resumePath);
    if (outputBytes.length > hostedOutputLimitBytes) throw new UserFacingTailoringError("The tailored resume exceeds the 15 MB storage limit.");
    uploadedObjectKey = `${run.user_id}/runs/${run.id}.docx`;
    const uploadResult = await admin.storage.from(hostedOutputFolder).upload(uploadedObjectKey, outputBytes, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: false,
    });
    if (uploadResult.error) throw new Error("Tailored resume could not be saved to private storage.");

    try {
      const saved = await persistHostedSkillCandidates(admin, tailored.skillCatalogCandidates);
      if (saved.pending) tailored.response.warnings.push(`${saved.pending} newly detected skill term${saved.pending === 1 ? " is" : "s are"} queued for review before future matching.`);
    } catch {
      tailored.response.warnings.push("New skill terms could not be saved to the shared catalog and may be rediscovered next time.");
    }

    const savedRun = await admin.from("tailoring_runs")
      .update({ status: "succeeded", result_data: tailored.response, output_object_key: uploadedObjectKey, error_code: null })
      .eq("id", run.id)
      .eq("user_id", run.user_id)
      .eq("status", "running");
    if (savedRun.error) throw new Error("Tailoring result could not be saved to the account.");
    uploadedObjectKey = undefined;
  } catch (error) {
    const userMessage = publicFailure(error);
    console.error("Hosted tailoring run failed:", error instanceof Error ? error.message : "unknown error");
    await admin.from("tailoring_runs")
      .update({ status: "failed", error_code: userMessage })
      .eq("id", run.id)
      .eq("user_id", run.user_id)
      .eq("status", "running");
  } finally {
    if (uploadedObjectKey) await admin.storage.from(hostedOutputFolder).remove([uploadedObjectKey]).catch(() => undefined);
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pumpHostedRunQueue(): Promise<void> {
  if (hostedQueuePumpRunning) {
    hostedQueuePumpRequested = true;
    return;
  }
  hostedQueuePumpRunning = true;
  try {
    do {
      hostedQueuePumpRequested = false;
      while (true) {
        const admin = getSupabaseAdminClient();
        const nextRun = await admin.from("tailoring_runs")
          .select("id, user_id")
          .eq("status", "queued")
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (nextRun.error || !nextRun.data) break;
        const claimed = await admin.from("tailoring_runs")
          .update({ status: "running" })
          .eq("id", nextRun.data.id)
          .eq("user_id", nextRun.data.user_id)
          .eq("status", "queued")
          .select("id, user_id")
          .maybeSingle();
        if (claimed.error) {
          console.error("Could not claim a hosted tailoring run.");
          break;
        }
        if (claimed.data) await processRun(claimed.data as ClaimedRun);
      }
    } while (hostedQueuePumpRequested);
  } catch {
    console.error("Hosted tailoring queue could not be checked.");
  } finally {
    hostedQueuePumpRunning = false;
    if (hostedQueuePumpRequested) void pumpHostedRunQueue();
  }
}

export async function recoverAndStartHostedTailoring(): Promise<void> {
  if (process.env.APP_MODE !== "hosted") return;
  try {
    const admin = getSupabaseAdminClient();
    await admin.from("tailoring_runs")
      .update({ status: "failed", error_code: "This run was interrupted by a service restart. Please retry." })
      .eq("status", "running");
  } catch {
    console.error("Could not recover interrupted hosted tailoring runs.");
  }
  void pumpHostedRunQueue();
}

export function queueHostedTailoring(): void {
  void pumpHostedRunQueue();
}

export async function cleanExpiredHostedTailoring(): Promise<void> {
  if (process.env.APP_MODE !== "hosted") return;
  try {
    const admin = getSupabaseAdminClient();
    const expired = await admin.from("tailoring_runs")
      .select("id, user_id, output_object_key")
      .lte("expires_at", new Date().toISOString())
      .limit(100);
    if (expired.error) return;
    for (const run of expired.data ?? []) {
      if (run.output_object_key) {
        const removed = await admin.storage.from(hostedOutputFolder).remove([run.output_object_key]);
        if (removed.error) continue;
      }
      await admin.from("tailoring_runs").delete().eq("id", run.id).eq("user_id", run.user_id);
    }

    const deletedResumes = await admin.from("resumes")
      .select("id, user_id, object_key")
      .not("deleted_at", "is", null)
      .limit(100);
    if (deletedResumes.error) {
      console.error("Soft-deleted hosted resume data could not be checked for cleanup.");
      return;
    }
    for (const resume of deletedResumes.data ?? []) {
      const removed = await admin.storage.from(hostedOutputFolder).remove([resume.object_key]);
      if (removed.error) continue;
      await admin.from("resumes").delete().eq("id", resume.id).eq("user_id", resume.user_id).not("deleted_at", "is", null);
    }
  } catch {
    console.error("Expired hosted tailoring data could not be cleaned up.");
  }
}
