"use client";

import { motion } from "framer-motion";
import { CoffeeIcon, GitHubIcon, RobotMark, StarIcon, XIcon } from "./icons";
import { BUYMEACOFFEE_URL, GITHUB_URL, TWITTER_URL } from "@/lib/site";

export default function Navbar() {
  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="fixed inset-x-0 top-0 z-50"
    >
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
        {/* Logo */}
        <a href="#top" className="flex items-center gap-2">
          <RobotMark className="h-8 w-8 drop-shadow-[0_0_12px_rgba(34,211,238,0.6)]" />
          <span className="text-[15px] font-medium tracking-tight text-white">ProofCast</span>
        </a>

        {/* Center tagline */}
        <span className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 text-[13px] font-light tracking-wide text-white/45 md:block">
          Proof before deployment.
        </span>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {/* X / Twitter */}
          <a
            href={TWITTER_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Suivre sur X"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/85 backdrop-blur transition hover:border-white/20 hover:bg-white/[0.07]"
          >
            <XIcon className="h-[15px] w-[15px]" />
          </a>

          {/* GitHub */}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[13px] font-medium text-white/85 backdrop-blur transition hover:border-white/20 hover:bg-white/[0.07]"
          >
            <GitHubIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Star on GitHub</span>
            <StarIcon className="h-3.5 w-3.5 text-amber-300/90 transition group-hover:scale-110" />
          </a>

          {/* Contribuer — Buy me a coffee */}
          <a
            href={BUYMEACOFFEE_URL}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-sky-400 to-cyan-500 px-3.5 py-1.5 text-[13px] font-medium text-slate-950 shadow-[0_0_18px_-4px_rgba(34,211,238,0.85)] transition hover:brightness-110"
          >
            <CoffeeIcon className="h-4 w-4 transition group-hover:scale-110" />
            <span className="hidden sm:inline">Contribuer</span>
          </a>
        </div>
      </nav>

      <div className="h-px w-full bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    </motion.header>
  );
}
