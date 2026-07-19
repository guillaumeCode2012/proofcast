/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export. This site is already fully static — every route builds as
  // `○ (Static)`, and there are no API routes, no dynamic rendering, and no
  // next/image usage — so exporting changes nothing about what ships.
  //
  // It is what lets the repo-root vercel.json serve the site at `/`: the Vercel
  // project's Root Directory is `.` (the repo root, a Node library with no `next`
  // dependency), so zero-config Next detection fails there. Building explicitly
  // and serving `landing/out` as static output sidesteps that without the route
  // namespacing that a `builds` entry would introduce.
  //
  // If this site ever needs SSR, an API route, or Image Optimization, drop this
  // line and instead set the Vercel project's Root Directory to `landing`.
  output: "export",
};

export default nextConfig;
