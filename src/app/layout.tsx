import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import Nav from "@/components/Nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  title: "ESG — Everything SideGig",
  description: "Post a gig or find work nearby.",
  applicationName: "ESG",
  appleWebApp: { capable: true, title: "ESG", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

// viewportFit "cover" lets the app use the full screen on notched phones; the
// header and bottom bar pad themselves with the safe-area insets.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#047857",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="app-shell min-h-full text-neutral-900">
        <AuthProvider>
          <Nav />
          <main className="app-content">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
