"use client";

import { useRef, useState } from "react";

interface InstallPromptProps {
  prompt: string;
}

type CopyState = "idle" | "copied" | "error";

const COPY_STATE_RESET_MS = 1800;

function fallbackCopyText(text: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  let succeeded = false;
  try {
    succeeded = document.execCommand("copy");
  } catch {
    succeeded = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return succeeded;
}

export function InstallPrompt({ prompt }: InstallPromptProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<number | null>(null);

  const clearResetTimer = () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };

  const scheduleReset = () => {
    clearResetTimer();
    resetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      resetTimerRef.current = null;
    }, COPY_STATE_RESET_MS);
  };

  const handleCopy = async () => {
    let succeeded = false;

    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(prompt);
        succeeded = true;
      } catch {
        succeeded = false;
      }
    }

    if (!succeeded) {
      succeeded = fallbackCopyText(prompt);
    }

    setCopyState(succeeded ? "copied" : "error");
    scheduleReset();
  };

  return (
    <section className="install-block">
      <div className="install-head">
        <h2>OpenClaw Setup</h2>
        <button type="button" className="copy-button" onClick={handleCopy}>
          {copyState === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <p>Copy and paste this prompt into OpenClaw:</p>
      <pre aria-label="OpenClaw setup prompt">
        <code>{prompt}</code>
      </pre>
      {copyState === "error" ? (
        <p className="copy-error">Copy failed. Please copy the text manually.</p>
      ) : null}
    </section>
  );
}
