import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import type { AuthenticatedAppUser } from "../shared/api";

function supabaseConfiguration(): { url: string; key: string; publicUrl: string } {
  const configuredUrl = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim();
  const publicUrl = process.env.PUBLIC_APP_URL?.trim();
  if (!configuredUrl || !key || !publicUrl) {
    throw new Error("Hosted authentication is not configured. Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and PUBLIC_APP_URL.");
  }

  let parsedSupabaseUrl: URL;
  let parsedPublicUrl: URL;
  try {
    parsedSupabaseUrl = new URL(configuredUrl);
    parsedPublicUrl = new URL(publicUrl);
  } catch {
    throw new Error("SUPABASE_URL and PUBLIC_APP_URL must be absolute HTTP or HTTPS URLs.");
  }
  if (!["http:", "https:"].includes(parsedSupabaseUrl.protocol) || parsedSupabaseUrl.username || parsedSupabaseUrl.password || parsedSupabaseUrl.pathname !== "/" || parsedSupabaseUrl.search || parsedSupabaseUrl.hash) {
    throw new Error("SUPABASE_URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment.");
  }
  if (!["http:", "https:"].includes(parsedPublicUrl.protocol) || parsedPublicUrl.username || parsedPublicUrl.password) {
    throw new Error("PUBLIC_APP_URL must be an absolute HTTP or HTTPS origin without credentials.");
  }
  if (parsedPublicUrl.pathname !== "/" || parsedPublicUrl.search || parsedPublicUrl.hash) {
    throw new Error("PUBLIC_APP_URL must not include a path, query, or fragment.");
  }
  if (process.env.NODE_ENV === "production" && parsedSupabaseUrl.protocol !== "https:") {
    throw new Error("SUPABASE_URL must use HTTPS in production.");
  }
  if (process.env.NODE_ENV === "production" && parsedPublicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_APP_URL must use HTTPS in production.");
  }
  return { url: parsedSupabaseUrl.origin, key, publicUrl: parsedPublicUrl.origin };
}

function requestCookies(request: Request): Array<{ name: string; value: string }> {
  const header = request.headers.cookie;
  if (!header) return [];
  return header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name) return [];
    try {
      return [{ name, value: decodeURIComponent(rawValue) }];
    } catch {
      return [{ name, value: rawValue }];
    }
  });
}

export function isHostedMode(): boolean {
  return process.env.APP_MODE === "hosted";
}

export function getSupabaseRequestClient(request: Request, response: Response) {
  const configuration = supabaseConfiguration();
  const secureCookies = new URL(configuration.publicUrl).protocol === "https:";
  return createServerClient(configuration.url, configuration.key, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    cookies: {
      getAll: () => requestCookies(request),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          response.cookie(name, value, {
            path: "/",
            httpOnly: true,
            secure: secureCookies,
            sameSite: "lax",
            ...(options.maxAge === undefined ? {} : { maxAge: Math.max(0, options.maxAge) * 1000 }),
            ...(options.expires ? { expires: options.expires } : {}),
          });
        }
      },
    },
  });
}

/** Server-only Supabase client for credential rows that authenticated browser roles cannot read. */
export function getSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Server-only Supabase access is not configured.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function googleCallbackUrl(): string {
  const { publicUrl } = supabaseConfiguration();
  return new URL("/auth/google/callback", publicUrl).toString();
}

export async function beginGoogleSignIn(request: Request, response: Response): Promise<string> {
  const supabase = getSupabaseRequestClient(request, response);
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: googleCallbackUrl(),
      skipBrowserRedirect: true,
    },
  });
  if (error || !data.url) throw new Error("Could not start Google sign-in.");
  return data.url;
}

export async function finishGoogleSignIn(request: Request, response: Response, code: string): Promise<AuthenticatedAppUser> {
  const supabase = getSupabaseRequestClient(request, response);
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) throw new Error("Google sign-in expired or could not be verified. Please try again.");

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("Could not verify the signed-in TailorResume account.");
  return toAppUser(data.user);
}

export async function getSignedInUser(request: Request, response: Response): Promise<AuthenticatedAppUser | null> {
  const supabase = getSupabaseRequestClient(request, response);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return toAppUser(data.user);
}

export async function endAppSession(request: Request, response: Response): Promise<void> {
  const supabase = getSupabaseRequestClient(request, response);
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw new Error("Could not sign out. Please retry.");
}

export function appOrigin(): string {
  return supabaseConfiguration().publicUrl;
}

function toAppUser(user: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}): AuthenticatedAppUser {
  const fullName = user.user_metadata?.full_name;
  const givenName = user.user_metadata?.name;
  const displayName = typeof fullName === "string" ? fullName : typeof givenName === "string" ? givenName : null;
  return { id: user.id, email: user.email ?? null, displayName };
}
