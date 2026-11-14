"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "@/lib/api-client";
import { Icon } from "@/components/ui";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState("/");
  const [toast, setToast] = useState<{ message: string; leaving: boolean } | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const removeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("next");
    if (target && target.startsWith("/") && !target.startsWith("//")) setNext(target);

    fetch("/api/auth/status")
      .then((res) => res.json() as Promise<{ enabled?: boolean }>)
      .then((data) => {
        if (data.enabled === false) window.location.replace("/");
      })
      .catch(() => {});
  }, []);

  useEffect(
    () => () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (removeTimerRef.current) window.clearTimeout(removeTimerRef.current);
    },
    []
  );

  function showError(message: string) {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (removeTimerRef.current) window.clearTimeout(removeTimerRef.current);
    setToast({ message, leaving: false });
    hideTimerRef.current = window.setTimeout(() => {
      setToast((prev) => (prev ? { ...prev, leaving: true } : prev));
      removeTimerRef.current = window.setTimeout(() => setToast(null), 220);
    }, 4600);
  }

  function dismissToast() {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (removeTimerRef.current) window.clearTimeout(removeTimerRef.current);
    setToast((prev) => (prev ? { ...prev, leaving: true } : prev));
    removeTimerRef.current = window.setTimeout(() => setToast(null), 220);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !password.trim()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(data?.error?.message ?? "密码错误");
      }
      window.location.replace(next);
      return;
    } catch (err) {
      showError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <span className="login-card__mark">V</span>
        <div>
          <h1 className="login-card__title">VIGGLE STUDIO</h1>
          <p className="login-card__hint">输入访问密码后继续</p>
        </div>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="访问密码"
          autoComplete="current-password"
          autoFocus
        />
        <button className="btn btn--primary" type="submit" disabled={busy || !password.trim()}>
          {busy ? <span className="spinner" /> : <Icon name="shield" size={15} />}
          进入工作台
        </button>
      </form>

      {toast && (
        <div className="toast-stack" aria-live="polite">
          <div className={`toast toast--error ${toast.leaving ? "is-leaving" : ""}`}>
            <Icon name="alert" size={15} />
            <span className="grow">{toast.message}</span>
            <button
              className="icon-btn"
              style={{ width: 20, height: 20, border: 0, background: "transparent" }}
              onClick={dismissToast}
              aria-label="关闭提示"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
