"use client";

import { motion } from "framer-motion";
import type { ComponentType, SVGProps } from "react";
import { CloudIcon, EyeOffIcon, HandoffIcon } from "./icons";

type Feature = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: EyeOffIcon,
    title: "Blind Trust is Dead",
    body: "Agents ship code you never watched run. ProofCast records the feature working and blocks deploy until you've seen the proof.",
  },
  {
    icon: HandoffIcon,
    title: "Agent-to-Agent Handoff",
    body: "Open the project in Codex, Claude Code or Cursor, say “configure proofcast”, and the agent wires the whole pipeline for you.",
  },
  {
    icon: CloudIcon,
    title: "Zero-Cost Infrastructure",
    body: "A Telegram bot, a local recorder and a Vercel deploy. No dashboards, no servers to babysit — bring your own AI key and go.",
  },
];

export default function WhySection() {
  return (
    <section id="why" className="relative mx-auto max-w-6xl px-5 py-28 sm:px-8">
      <div className="mx-auto mb-16 max-w-2xl text-center">
        <p className="mb-3 text-[12px] font-light uppercase tracking-[0.25em] text-white/40">
          Why ProofCast
        </p>
        <h2 className="text-balance text-3xl font-extralight tracking-tight text-white sm:text-5xl">
          Proof before deployment.
        </h2>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {FEATURES.map((feature, i) => (
          <motion.article
            key={feature.title}
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6, ease: "easeOut", delay: i * 0.1 }}
            className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-7 transition hover:border-white/20 hover:bg-white/[0.04]"
          >
            <div
              aria-hidden
              className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.20),transparent_65%)] opacity-0 blur-2xl transition group-hover:opacity-100"
            />
            <div className="mb-5 grid h-11 w-11 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-cyan-300">
              <feature.icon className="h-5 w-5" />
            </div>
            <h3 className="mb-2 text-[17px] font-medium tracking-tight text-white">
              {feature.title}
            </h3>
            <p className="text-[14px] font-light leading-relaxed text-white/50">
              {feature.body}
            </p>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
