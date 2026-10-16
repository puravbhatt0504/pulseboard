"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setToken } from "@/lib/api";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = { email: form.get("email"), password: form.get("password") };
    setBusy(true);
    setError("");
    try {
      if (mode === "register") await api("/auth/register", { method: "POST", body });
      const { accessToken } = await api<{ accessToken: string }>("/auth/login", { method: "POST", body });
      setToken(accessToken);
      router.push("/boards");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const title = mode === "login" ? "Sign in" : "Create account";
  const field = "mt-1 h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 shadow-xs outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200";
  return (
    <main className="mx-auto mt-20 max-w-sm px-4">
      <p className="mb-1 text-sm font-semibold tracking-wide text-violet-700">PulseBoard</p>
      <p className="mb-6 text-sm text-zinc-500">Realtime Kanban with AI triage and search.</p>
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="mb-5 text-xl font-semibold tracking-tight">{title}</h1>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">Email</span>
            <input name="email" type="email" required autoComplete="email" className={field} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className={field}
            />
          </label>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button disabled={busy} className="h-10 w-full rounded-lg bg-zinc-900 font-medium text-white hover:bg-zinc-700 disabled:opacity-50">
            {title}
          </button>
        </form>
      </div>
      <p className="mt-4 text-center text-sm text-zinc-600">
        {mode === "login" ? (
          <>No account? <Link href="/register" className="font-medium underline">Register</Link></>
        ) : (
          <>Have an account? <Link href="/login" className="font-medium underline">Sign in</Link></>
        )}
      </p>
    </main>
  );
}
