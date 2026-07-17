"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RobotMark } from "./icons";

type Message =
  | { from: "user" | "bot"; kind: "text"; text: string }
  | { from: "bot"; kind: "video" };

/** The exact ProofCast flow, animated line by line. */
const SCRIPT: Message[] = [
  { from: "user", kind: "text", text: "Démo a payment page" },
  {
    from: "bot",
    kind: "text",
    text: "🧠 Feature generated.\n📦 Booted in an isolated sandbox.\n🎥 Recording the proof…",
  },
  { from: "bot", kind: "video" },
  { from: "user", kind: "text", text: "Déploie" },
  {
    from: "bot",
    kind: "text",
    text: "🚀 Proof verified. Live at: payment-app.vercel.app",
  },
];

const VERCEL_LINK = "payment-app.vercel.app";

export default function LivePhone() {
  const [shown, setShown] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(setTimeout(resolve, ms));
      });

    (async function loop() {
      while (!cancelled) {
        setShown([]);
        setTyping(false);
        await wait(900);

        for (const message of SCRIPT) {
          if (cancelled) return;
          if (message.from === "bot") {
            setTyping(true);
            await wait(1400);
            if (cancelled) return;
            setTyping(false);
          }
          setShown((current) => [...current, message]);
          await wait(message.from === "bot" ? 1700 : 1000);
        }

        await wait(3000); // hold the finished conversation, then restart
      }
    })();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    // Scroll ONLY the inner chat container — never the window, so the user's
    // page scroll is never hijacked as new bubbles appear.
    const el = chatRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [shown, typing]);

  return (
    <div className="relative">
      {/* Neon glow behind the phone */}
      <div
        aria-hidden
        className="animate-pulse-glow absolute left-1/2 top-1/2 -z-10 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(14,165,233,0.5),rgba(45,212,191,0.28)_45%,transparent_70%)] blur-3xl"
      />

      {/* 3D stage */}
      <div style={{ perspective: "1400px" }} className="mx-auto w-fit">
        <motion.div
          initial={{ opacity: 0, y: 60, rotateX: 12 }}
          animate={{ opacity: 1, y: 0, rotateX: 6 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
          style={{
            transform: "rotateY(-6deg) rotateX(6deg)",
            transformStyle: "preserve-3d",
            boxShadow:
              "0 50px 120px -30px rgba(56,189,248,0.4), 0 30px 90px -40px rgba(14,165,233,0.5), inset 0 0 0 1px rgba(255,255,255,0.06)",
          }}
          className="relative w-[288px] rounded-[44px] border border-white/10 bg-gradient-to-b from-[#131313] to-[#050505] p-2.5 sm:w-[320px]"
        >
          {/* Notch */}
          <div className="absolute left-1/2 top-2.5 z-20 h-6 w-32 -translate-x-1/2 rounded-b-2xl rounded-t-md bg-black">
            <div className="absolute right-6 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-white/10" />
            <div className="absolute right-9 top-1/2 h-1 w-8 -translate-y-1/2 rounded-full bg-white/[0.06]" />
          </div>

          {/* Screen */}
          <div className="relative flex h-[560px] flex-col overflow-hidden rounded-[34px] bg-tg-bg sm:h-[600px]">
            {/* Telegram header */}
            <div className="flex shrink-0 items-center gap-3 border-b border-black/40 bg-tg-header px-4 pb-2.5 pt-8">
              <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-full bg-[#0a0f16]">
                <RobotMark idPrefix="tg" className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-white">ProofCast Bot</p>
                <p className="text-[11px] text-emerald-400/90">online</p>
              </div>
              <div className="flex gap-1">
                <span className="h-1 w-1 rounded-full bg-white/40" />
                <span className="h-1 w-1 rounded-full bg-white/40" />
                <span className="h-1 w-1 rounded-full bg-white/40" />
              </div>
            </div>

            {/* Chat */}
            <div
              ref={chatRef}
              className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
            >
              <AnimatePresence initial={false}>
                {shown.map((message, index) => (
                  <Bubble key={index} message={message} />
                ))}
                {typing && <TypingBubble key="typing" />}
              </AnimatePresence>
            </div>

            {/* Fake input bar */}
            <div className="flex shrink-0 items-center gap-2 border-t border-black/40 bg-tg-header px-3 py-2.5">
              <div className="flex-1 rounded-full bg-white/[0.06] px-3.5 py-2 text-[12px] text-tg-muted">
                Message
              </div>
              <div className="grid h-8 w-8 place-items-center rounded-full bg-tg-link">
                <svg viewBox="0 0 24 24" className="h-4 w-4 -rotate-45 fill-white">
                  <path d="M2 21l21-9L2 3v7l15 2-15 2z" />
                </svg>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const isUser = message.from === "user";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed shadow-sm ${
          isUser
            ? "rounded-br-md bg-tg-outgoing text-white"
            : "rounded-bl-md bg-tg-incoming text-white/95"
        }`}
      >
        {message.kind === "video" ? (
          <VideoMessage />
        ) : (
          <span className="whitespace-pre-line">{renderText(message.text)}</span>
        )}
        <span
          className={`mt-1 block text-right text-[10px] ${
            isUser ? "text-white/55" : "text-tg-muted"
          }`}
        >
          09:41
        </span>
      </div>
    </motion.div>
  );
}

function renderText(text: string) {
  if (!text.includes(VERCEL_LINK)) return text;
  const [before, after] = text.split(VERCEL_LINK);
  return (
    <>
      {before}
      <a className="font-medium text-tg-link underline decoration-tg-link/40 underline-offset-2">
        {VERCEL_LINK}
      </a>
      {after}
    </>
  );
}

function VideoMessage() {
  return (
    <div className="w-[200px] overflow-hidden rounded-xl">
      <div className="relative overflow-hidden rounded-lg bg-black">
        {/* The real recorded proof — a live browser using the feature. */}
        <video
          src="/proofcast-demo.mp4"
          autoPlay
          muted
          loop
          playsInline
          className="block aspect-[16/10] w-full object-cover"
        />

        {/* Duration chip */}
        <span className="absolute right-2 top-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white/80">
          0:10
        </span>
      </div>
      <p className="mt-1 text-[11px] text-tg-muted">proofcast-demo.mp4</p>
    </div>
  );
}

function TypingBubble() {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.25 }}
      className="flex justify-start"
    >
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-tg-incoming px-3.5 py-3">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-white/60"
            animate={{ opacity: [0.25, 1, 0.25], y: [0, -2.5, 0] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
      </div>
    </motion.div>
  );
}
