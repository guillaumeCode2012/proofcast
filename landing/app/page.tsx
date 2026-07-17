import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import WhySection from "@/components/WhySection";
import FooterCTA from "@/components/FooterCTA";

export default function Home() {
  return (
    <main className="relative min-h-screen bg-[#050505] text-white">
      {/* faint vignette / grain overlay */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-20 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.05),transparent_45%)]"
      />
      <Navbar />
      <Hero />
      <WhySection />
      <FooterCTA />
    </main>
  );
}
