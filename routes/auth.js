"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

const API_URL = "https://goldmart-backend-yoxc.onrender.com";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Login failed");
      }

      // Save authentication
      localStorage.setItem("goldmart_token", data.token);
      localStorage.setItem(
        "goldmart_user",
        JSON.stringify(data.user)
      );

      // Redirect based on account type
      if (data.user.role === "seller") {
        router.push("/seller");
      } else {
        router.push("/");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">

        <Link
          href="/"
          className="mb-8 block text-center text-3xl font-black"
        >
          Gold<span className="text-[#D4AF37]">Mart</span>
        </Link>

        <div className="rounded-3xl bg-white p-6 shadow-sm sm:p-8">

          <h1 className="text-3xl font-black">
            Welcome Back
          </h1>

          <p className="mt-2 text-gray-500">
            Sign in to your GoldMart account.
          </p>

          {error && (
            <div className="mt-6 rounded-xl bg-red-50 p-4 text-sm font-medium text-red-700">
              {error}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="mt-8 space-y-5"
          >

            <div>
              <label className="mb-2 block text-sm font-bold">
                Email
              </label>

              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-xl border px-4 py-3 outline-none focus:border-[#D4AF37]"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-bold">
                Password
              </label>

              <input
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                className="w-full rounded-xl border px-4 py-3 outline-none focus:border-[#D4AF37]"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-black py-3 font-bold text-white transition hover:bg-[#D4AF37] hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Signing In..." : "Sign In"}
            </button>

          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            Don't have an account?{" "}
            <Link
              href="/register"
              className="font-bold text-[#A67C00]"
            >
              Create one
            </Link>
          </p>

        </div>
      </div>
    </main>
  );
}
