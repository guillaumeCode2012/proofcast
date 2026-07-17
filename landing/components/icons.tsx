import type { SVGProps } from "react";

/**
 * ProofCast mascot — the little cyan robot. Recreated as clean vector so it stays
 * crisp from favicon size up to hero size and always renders on a transparent
 * background. `idPrefix` keeps gradient ids unique when several render on a page.
 */
export function RobotMark({
  idPrefix = "rm",
  ...props
}: SVGProps<SVGSVGElement> & { idPrefix?: string }) {
  const body = `${idPrefix}-body`;
  const eye = `${idPrefix}-eye`;
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden {...props}>
      <defs>
        <linearGradient id={body} x1="32" y1="10" x2="32" y2="61" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8ED8F4" />
          <stop offset="1" stopColor="#35A0E2" />
        </linearGradient>
        <radialGradient id={eye} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#C4FFF6" />
          <stop offset="0.45" stopColor="#48E6D4" />
          <stop offset="1" stopColor="#1FC4B4" />
        </radialGradient>
      </defs>

      {/* arms (tucked behind the body) */}
      <g fill={`url(#${body})`}>
        <rect x="6" y="39" width="8" height="16" rx="4" transform="rotate(15 10 47)" />
        <rect x="50" y="39" width="8" height="16" rx="4" transform="rotate(-15 54 47)" />
      </g>

      {/* foot */}
      <rect x="27.5" y="55" width="9" height="7" rx="2.4" fill="#2F92D6" />

      {/* antenna (base hidden by the head) */}
      <rect x="30.7" y="7.5" width="2.6" height="12" rx="1.3" fill={`url(#${body})`} />
      <circle cx="32" cy="6" r="3.7" fill={`url(#${body})`} />

      {/* head + body */}
      <path
        d="M32 15 C41 15 48.6 19 50 27 C51.4 34 51.6 44 49 51 C46.7 57 40 60 32 60 C24 60 17.3 57 15 51 C12.4 44 12.6 34 14 27 C15.4 19 23 15 32 15 Z"
        fill={`url(#${body})`}
      />

      {/* visor */}
      <rect x="18.4" y="24.8" width="27.2" height="14.6" rx="7.3" fill="#0A0F14" />

      {/* glowing eyes */}
      <circle cx="27" cy="32.1" r="2.75" fill={`url(#${eye})`} />
      <circle cx="37" cy="32.1" r="2.75" fill={`url(#${eye})`} />
    </svg>
  );
}

export function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" />
    </svg>
  );
}

export function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function CoffeeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
      <path d="M6 2v2M10 2v2M14 2v2" />
    </svg>
  );
}

export function StarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  );
}

export function PlayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function EyeOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.4 5.2A9.5 9.5 0 0 1 12 5c5 0 9 5 9 7a12.3 12.3 0 0 1-2.2 2.9" />
      <path d="M6.1 6.1C3.9 7.5 2 10 2 12c0 2 4 7 10 7a9.9 9.9 0 0 0 3.5-.6" />
    </svg>
  );
}

export function HandoffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M10 7H7a5 5 0 0 0 0 10h3" />
      <path d="M14 17h3a5 5 0 0 0 0-10h-3" />
      <path d="M8 12h8" />
    </svg>
  );
}

export function CloudIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 6.98" />
      <path d="M12 13v6" />
      <path d="m9.5 16.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}
