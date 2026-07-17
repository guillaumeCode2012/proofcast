"use client";

import { motion } from "framer-motion";
import { GitHubIcon } from "./icons";
import { GITHUB_URL } from "@/lib/site";

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.15 + i * 0.12 },
  }),
};

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden px-5 pb-24 pt-36 sm:pt-44">
      {/* Ambient background glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
      >
        <div className="absolute left-1/2 top-[-10%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse,rgba(14,165,233,0.32),transparent_60%)] blur-2xl" />
        <div className="absolute left-1/2 top-[38%] h-[380px] w-[380px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(45,212,191,0.18),transparent_60%)] blur-2xl" />
      </div>

      <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
        <motion.span
          custom={0}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[12px] font-light tracking-wide text-white/60"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_1px_rgba(34,211,238,0.85)]" />
          The agentic deploy engine
        </motion.span>

        <motion.h1
          custom={1}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="text-balance text-6xl font-extralight leading-[0.95] tracking-tighter text-white sm:text-8xl"
        >
          Don&apos;t trust.
          <br />
          <span className="bg-gradient-to-br from-white via-white to-white/40 bg-clip-text text-transparent">
            Verify.
          </span>
        </motion.h1>

        <motion.p
          custom={2}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="mt-7 max-w-xl text-balance text-base font-light leading-relaxed text-white/55 sm:text-lg"
        >
          The agentic engine that delivers a video proof of your feature before it deploys.
        </motion.p>

        <motion.div
          custom={3}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="mt-9 flex items-center gap-3"
        >
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-[14px] font-medium text-black transition hover:bg-white/90"
          >
            <GitHubIcon className="h-4 w-4" />
            Star on GitHub
          </a>
          <a
            href="#why"
            className="rounded-full border border-white/10 px-5 py-2.5 text-[14px] font-light text-white/70 transition hover:border-white/25 hover:text-white"
          >
            How it works →
          </a>
        </motion.div>
      </div>

      {/* The centerpiece — a recorded proof demo inside the phone */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 0.5 }}
        className="mt-20 flex justify-center sm:mt-24"
      >
        <video
          src="/proofcast-demo-phone.mp4"
          autoPlay
          muted
          loop
          playsInline
          aria-label="ProofCast in Telegram: Démo a payment page — the bot builds it, records a real-browser proof of the checkout (buy, card form, payment accepted), then Déploie ships it live."
          className="h-auto w-[300px] sm:w-[340px]"
        />
      </motion.div>
    </section>
  );
}
