"use client";

import { motion } from "framer-motion";
import { GitHubIcon, RobotMark } from "./icons";
import { GITHUB_URL } from "@/lib/site";

export default function FooterCTA() {
  return (
    <footer className="relative overflow-hidden px-5 py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[360px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse,rgba(14,165,233,0.38),rgba(45,212,191,0.16)_45%,transparent_70%)] blur-3xl"
      />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.7, ease: "easeOut" }}
        className="mx-auto flex max-w-3xl flex-col items-center text-center"
      >
        <h2 className="text-balance text-4xl font-extralight tracking-tighter text-white sm:text-6xl">
          Ready to ship safely?
        </h2>
        <p className="mt-5 max-w-lg text-base font-light text-white/50">
          Download it, open it in your agent, and let ProofCast prove your feature
          before it ever reaches production.
        </p>

        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-9 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-[15px] font-medium text-black transition hover:bg-white/90"
        >
          <GitHubIcon className="h-[18px] w-[18px]" />
          Get it on GitHub
        </a>
      </motion.div>

      <div className="mx-auto mt-24 flex max-w-6xl flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 text-[13px] font-light text-white/35 sm:flex-row">
        <div className="flex items-center gap-2">
          <RobotMark idPrefix="footer" className="h-5 w-5" />
          <span>ProofCast — Don&apos;t trust. Verify.</span>
        </div>
        <span>MIT © 2026</span>
      </div>
    </footer>
  );
}
