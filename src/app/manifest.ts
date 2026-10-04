import type { MetadataRoute } from "next";

// Lets phones "Add to Home Screen" and launch ESG as a standalone app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ESG — Everything SideGig",
    short_name: "ESG",
    description: "Post a gig or find work nearby.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f8f7",
    theme_color: "#047857",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
