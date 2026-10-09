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
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm text-zinc-600">Email</span>
          <input name="email" type="email" required autoComplete="email" className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-sm text-zinc-600">Password</span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className="mt-1 w-full rounded border border-zinc-300 px-3 py-2"
          />
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full rounded bg-zinc-900 py-2 text-white disabled:opacity-50">
          {title}
        </button>
      </form>
      <p className="mt-4 text-sm text-zinc-600">
        {mode === "login" ? (
          <>No account? <Link href="/register" className="underline">Register</Link></>
        ) : (
          <>Have an account? <Link href="/login" className="underline">Sign in</Link></>
        )}
      </p>
    </main>
  );
}
