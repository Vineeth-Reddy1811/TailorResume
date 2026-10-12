import { promises as fs } from "fs";
import { createTailoringRun, UserFacingTailoringError, type TailoringExecutionOptions } from "./tailoringService";
import { decryptProviderCredential } from "./providerCredentials";
import { getSupabaseAdminClient } from "./supabaseAuth";
import type { TailoringRunResponse } from "../shared/api";

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
  if (error instanceof Error && /^OpenAI API (?:key was rejected|rate limited|tailoring request failed|did not|returned)/.test(error.message)) return error.message;
  return "Resume processing could not be completed. Check the saved resume and AI provider connection, then retry.";
}

function mergeLearnedSkills(baseValue: unknown, currentValue: unknown): Record<string, unknown> | null {
  if (!baseValue || typeof baseValue !== "object" || Array.isArray(baseValue) ||
      !currentValue || typeof currentValue !== "object" || Array.isArray(currentValue)) return null;
  const base = baseValue as Record<string, unknown>;
  const current = currentValue as Record<string, unknown>;
  const baseSkills = Array.isArray(base.verifiedSkills) ? base.verifiedSkills : [];
  const learned = Array.isArray(current.verifiedSkills) ? current.verifiedSkills : [];
  const mergedSkills = Array.isArray(base.verifiedSkills) ? [...baseSkills] : [];
  for (const rawSkill of learned) {
    if (!rawSkill || typeof rawSkill !== "object" || Array.isArray(rawSkill)) continue;
    const skill = rawSkill as Record<string, unknown>;
    if (typeof skill.canonical !== "string" || !skill.canonical.trim()) continue;
    const canonical = skill.canonical.trim().toLowerCase();
    const existingIndex = mergedSkills.findIndex((entry) => entry && typeof entry === "object" &&
      !Array.isArray(entry) && typeof (entry as Record<string, unknown>).canonical === "string" &&
      ((entry as Record<string, unknown>).canonical as string).trim().toLowerCase() === canonical);
    if (existingIndex < 0) {
      mergedSkills.push(skill);
      continue;
    }
    const existing = mergedSkills[existingIndex] as Record<string, unknown>;
    const aliases = [existing.canonical, ...(Array.isArray(existing.aliases) ? existing.aliases : []), ...(Array.isArray(skill.aliases) ? skill.aliases : [])]
      .filter((alias): alias is string => typeof alias === "string" && Boolean(alias.trim()));
    mergedSkills[existingIndex] = {
      ...existing,
      aliases: [...new Set(aliases)],
      verified: true,
      userConfirmed: true,
      source: typeof skill.source === "string" ? skill.source : existing.source,
    };
  }
  return { ...base, verifiedSkills: mergedSkills };
}

async function processRun(run: ClaimedRun): Promise<void> {
  const admin = getSupabaseAdminClient();
  let temporaryDirectory: string | undefined;
  let uploadedObjectKey: string | undefined;
  try {
    const runResult = await admin.from("tailoring_runs")
      .select("id, user_id, source_resume_id, job_description, provider, model, expires_at, status")
      .eq("id", run.id)
      .eq("user_id", run.user_id)
      .maybeSingle();
    const runRow = runResult.data;
    if (runResult.error || !runRow || runRow.status !== "running") return;
    if ((runRow.provider !== "anthropic" && runRow.provider !== "openai") || typeof runRow.model !== "string" || !runRow.model || typeof runRow.job_description !== "string") {
      throw new UserFacingTailoringError("This run is missing a supported AI provider or model. Update AI provider settings and retry.");
    }
    const provider = runRow.provider;
    const providerLabel = provider === "openai" ? "OpenAI API" : "Claude";

    const [resumeResult, profileResult, credentialResult] = await Promise.all([
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
      admin.from("provider_connections")
        .select("credential_ciphertext, credential_iv, credential_auth_tag, key_version, selected_model")
        .eq("user_id", run.user_id)
        .eq("provider", provider)
        .maybeSingle(),
    ]);
    if (resumeResult.error || !resumeResult.data) throw new UserFacingTailoringError("Your saved base resume is no longer available. Upload it again, then retry.");
    if (profileResult.error || !profileResult.data?.profile_data) throw new UserFacingTailoringError("Your resume profile is unavailable. Upload or replace your base resume, then retry.");
    if (credentialResult.error || !credentialResult.data || credentialResult.data.selected_model !== runRow.model) {
      throw new UserFacingTailoringError(`The ${providerLabel} key or selected model changed before this run started. Retry with your current provider settings.`);
    }

    const credential = decryptProviderCredential(run.user_id, provider, {
      ciphertext: credentialResult.data.credential_ciphertext,
      iv: credentialResult.data.credential_iv,
      authTag: credentialResult.data.credential_auth_tag,
      keyVersion: credentialResult.data.key_version,
    });
    const download = await admin.storage.from(hostedOutputFolder).download(resumeResult.data.object_key);
    if (download.error || !download.data) throw new UserFacingTailoringError("Your saved base resume could not be opened. Replace it in the resume section and retry.");
    const resumeBytes = Buffer.from(await download.data.arrayBuffer());
    const profileData = profileResult.data.profile_data as Record<string, unknown>;
    const options: TailoringExecutionOptions = {
      experienceProfile: profileData,
      provider,
      providerApiKey: credential,
      model: runRow.model,
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

    const completedProfileText = await fs.readFile(`${temporaryDirectory}/experience-profile.json`, "utf8").catch(() => "");
    if (completedProfileText) {
      try {
        const completedProfile = JSON.parse(completedProfileText) as unknown;
        const latestProfile = await admin.from("experience_profiles")
          .select("profile_data, updated_at")
          .eq("user_id", run.user_id)
          .maybeSingle();
        if (!latestProfile.error && latestProfile.data) {
          const merged = mergeLearnedSkills(latestProfile.data.profile_data, completedProfile);
          if (merged) {
            const savedProfile = await admin.from("experience_profiles")
              .update({ profile_data: merged })
              .eq("user_id", run.user_id)
              .eq("updated_at", latestProfile.data.updated_at)
              .select("user_id")
              .maybeSingle();
            if (savedProfile.error || !savedProfile.data) {
              tailored.response.warnings.push("Newly detected skills were not saved because your resume profile changed during this run. They may be detected again on a later run.");
            }
          }
        } else {
          tailored.response.warnings.push("Newly detected skills could not be saved to your account profile. They may be detected again on a later run.");
        }
      } catch {
        tailored.response.warnings.push("Newly detected skills could not be saved to your account profile. They may be detected again on a later run.");
      }
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
